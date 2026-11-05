// Katie & Michael's Happily Ever After Party: website server.
//
// Serves the one-page site, keeps everything editable in Postgres (or in memory when
// DATABASE_URL is not set, for local testing), saves RSVPs, protects Admin with a shared
// password, and streams guest photo uploads into the Railway bucket.
//
// Environment:
//   PORT               set by Railway
//   DATABASE_URL       Postgres connection string (Railway: ${{Postgres.DATABASE_URL}})
//   ADMIN_PASSWORD     the Admin login password
//   SESSION_SECRET     random string used to sign the Admin login cookie
//   BUCKET, ENDPOINT, REGION, ACCESS_KEY_ID, SECRET_ACCESS_KEY   the photo bucket
//   LOCAL_UPLOAD_DIR   local testing only: store uploads on disk when no bucket is set

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Busboy from 'busboy';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3000);

const PUBLIC_COLLECTIONS = ['quotes', 'story', 'details', 'faq', 'awards', 'notes', 'cats', 'pages'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DOC_BYTES = 300 * 1024;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // per file
const MAX_FILES_PER_REQUEST = 30;

/* ---------------- storage: documents ---------------- */

function memoryStore() {
  const data = new Map();
  const col = (c) => { if (!data.has(c)) data.set(c, new Map()); return data.get(c); };
  return {
    kind: 'memory',
    async init() {},
    async list(c) { return [...col(c).entries()].map(([id, d]) => ({ id, ...d })); },
    async get(c, id) { const d = col(c).get(id); return d ? { id, ...d } : null; },
    async put(c, id, d) { col(c).set(id, d); },
    async del(c, id) { col(c).delete(id); },
  };
}

function postgresStore(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS docs (
        collection text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      )`);
    },
    async list(c) {
      const r = await pool.query('SELECT id, data FROM docs WHERE collection = $1', [c]);
      return r.rows.map((row) => ({ id: row.id, ...row.data }));
    },
    async get(c, id) {
      const r = await pool.query('SELECT id, data FROM docs WHERE collection = $1 AND id = $2', [c, id]);
      return r.rows[0] ? { id: r.rows[0].id, ...r.rows[0].data } : null;
    },
    async put(c, id, d) {
      await pool.query(
        `INSERT INTO docs (collection, id, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [c, id, JSON.stringify(d)]
      );
    },
    async del(c, id) { await pool.query('DELETE FROM docs WHERE collection = $1 AND id = $2', [c, id]); },
  };
}

const store = env.DATABASE_URL ? postgresStore(env.DATABASE_URL) : memoryStore();

async function seedOnce() {
  if (await store.get('meta', 'seeded')) return;
  const seedPath = path.join(here, 'seed.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    let n = 0;
    for (const [collection, docs] of Object.entries(seed)) {
      if (!PUBLIC_COLLECTIONS.includes(collection)) continue;
      for (const doc of docs) { await store.put(collection, doc.id, doc.data); n++; }
    }
    console.log(`Seeded ${n} documents from seed.json`);
  }
  await store.put('meta', 'seeded', { at: new Date().toISOString() });
}

/* ---------------- storage: photos ---------------- */

const s3Ready = !!(env.BUCKET && env.ENDPOINT && env.ACCESS_KEY_ID && env.SECRET_ACCESS_KEY);
const s3 = s3Ready ? new S3Client({
  region: env.REGION || 'auto',
  endpoint: env.ENDPOINT,
  credentials: { accessKeyId: env.ACCESS_KEY_ID, secretAccessKey: env.SECRET_ACCESS_KEY },
}) : null;
const localDir = !s3Ready && env.LOCAL_UPLOAD_DIR ? env.LOCAL_UPLOAD_DIR : null;
const uploadsEnabled = !!(s3 || localDir);

async function putObject(key, stream, contentType) {
  if (s3) {
    await new Upload({ client: s3, params: { Bucket: env.BUCKET, Key: key, Body: stream, ContentType: contentType } }).done();
    return;
  }
  const file = path.join(localDir, key.replace(/\//g, '_'));
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    stream.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    stream.on('error', reject);
  });
}
async function deleteObject(key) {
  if (s3) { await s3.send(new DeleteObjectCommand({ Bucket: env.BUCKET, Key: key })); return; }
  if (localDir) fs.rmSync(path.join(localDir, key.replace(/\//g, '_')), { force: true });
}

/* ---------------- helpers ---------------- */

const newId = () => crypto.randomBytes(9).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

const SESSION_SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; admin logins will reset when the server restarts.');
const COOKIE = 'hea_admin';
const SESSION_DAYS = 30;

function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  const raw = readCookie(req, COOKIE);
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return false;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Log in to Admin first.' });
}

// Small fixed-window rate limiter, per client address and purpose.
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return next(); }
    entry.count++;
    if (entry.count > max) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------------- app ---------------- */

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

const indexFile = path.join(here, 'public', 'index.html');
const sendIndex = (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(indexFile); };
app.get(['/', '/admin'], sendIndex);
app.use('/img', express.static(path.join(here, 'public', 'img'), { maxAge: '7d' }));

const json = express.json({ limit: '1mb' });

// Everything guests can read.
app.get('/api/content', async (req, res) => {
  try {
    const out = {};
    for (const c of PUBLIC_COLLECTIONS) out[c] = await store.list(c);
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  } catch (error) {
    console.error('content', error);
    res.status(500).json({ error: 'The site could not load its content.' });
  }
});

app.get('/api/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ admin: isAdmin(req), uploads: uploadsEnabled });
});

app.post('/api/login', limit('login', 10, 15 * 60_000), json, (req, res) => {
  if (!env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin is not set up yet: the ADMIN_PASSWORD variable is missing.' });
  const given = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!crypto.timingSafeEqual(sha(given), sha(env.ADMIN_PASSWORD))) return res.status(401).json({ error: 'That password is not right.' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

/* ----- RSVP ----- */

// One reply per name: sending again with the same name replaces the earlier reply.
// A "yes" lists every person coming: name and age group required, photo and comment optional.
const AGE_GROUPS = ['keiki', 'adult', 'kupuna'];
const MAX_GUESTS = 20;
const MAX_RSVP_PHOTO_BYTES = 25 * 1024 * 1024;
const normName = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
const rsvpId = (name) => crypto.createHash('sha256').update(normName(name)).digest('base64url').slice(0, 22);

function checkRsvp(body) {
  const name = clean(body?.name, 120);
  const attending = body?.attending === 'yes' ? 'yes' : body?.attending === 'no' ? 'no' : '';
  if (!name) return { error: 'Add your name so we know who is replying.' };
  if (!attending) return { error: 'Choose yes or no.' };
  if (attending === 'no') return { reply: { name, attending, count: 0, guests: [] } };
  if (Array.isArray(body.guests)) {
    if (!body.guests.length) return { error: 'Add at least one paddler.' };
    if (body.guests.length > MAX_GUESTS) return { error: `That is more than ${MAX_GUESTS} paddlers. Send the rest in a second reply.` };
    const guests = [];
    for (const [i, g] of body.guests.entries()) {
      const gname = clean(g?.name, 120);
      const age = AGE_GROUPS.includes(g?.age) ? g.age : '';
      if (!gname) return { error: `Paddler ${i + 1} needs a name.` };
      if (!age) return { error: `Pick an age group for ${gname}.` };
      guests.push({ name: gname, age, comment: clean(g?.comment, 300), photo: null });
    }
    return { reply: { name, attending, count: guests.length, guests } };
  }
  // Older form (party size only), in case a page loaded before this update sends a reply.
  let count = parseInt(body?.count, 10);
  if (!(count >= 1)) count = 1;
  return { reply: { name, attending, count: Math.min(count, MAX_GUESTS), guests: [] } };
}

// Reads a multipart RSVP: a "data" JSON field plus photo-<n> files (n = paddler index).
// Photos go straight to the bucket; the caller deletes them if the reply is not saved.
function readRsvpForm(req) {
  return new Promise((resolve) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: MAX_GUESTS, fileSize: MAX_RSVP_PHOTO_BYTES, fields: 5, fieldSize: 64 * 1024 } });
    } catch {
      return resolve({ failed: true, photos: new Map(), problems: [] });
    }
    let data = null, finished = false;
    const photos = new Map(), problems = [], pending = [];
    const finish = async (failed) => {
      if (finished) return;
      finished = true;
      await Promise.allSettled(pending);
      resolve({ data, photos, problems, failed });
    };
    busboy.on('field', (name, value) => {
      if (name === 'data') { try { data = JSON.parse(value); } catch { data = null; } }
    });
    busboy.on('file', (field, stream, info) => {
      const m = /^photo-(\d{1,2})$/.exec(field);
      const index = m ? Number(m[1]) : -1;
      const type = (info.mimeType || '').toLowerCase();
      if (index < 0 || index >= MAX_GUESTS || photos.has(index) || !uploadsEnabled) { stream.resume(); return; }
      if (!type.startsWith('image/')) { problems.push({ index, why: 'type' }); stream.resume(); return; }
      const id = newId();
      const ext = (path.extname(info.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '').slice(0, 8);
      const key = `rsvp-photos/${new Date().toISOString().slice(0, 10)}/${id}${ext}`;
      const photo = { id, key, type, size: 0 };
      photos.set(index, photo);
      let tooBig = false;
      stream.on('data', (chunk) => { photo.size += chunk.length; });
      stream.on('limit', () => { tooBig = true; });
      pending.push(
        putObject(key, stream, type)
          .then(() => { if (tooBig) problems.push({ index, why: 'size' }); })
          .catch((error) => { console.error('rsvp photo', error); stream.resume(); problems.push({ index, why: 'save' }); })
      );
    });
    busboy.on('error', (error) => { console.error('rsvp form', error); finish(true); });
    busboy.on('close', () => finish(false));
    req.on('aborted', () => finish(true));
    req.pipe(busboy);
  });
}

const dropPhotos = async (list) => {
  for (const p of list) { try { await deleteObject(p.key); } catch (error) { console.error('delete rsvp photo', error); } }
};

async function saveRsvp(reply, photos) {
  const id = rsvpId(reply.name);
  const old = await store.get('rsvps', id);
  const oldGuests = Array.isArray(old?.guests) ? old.guests : [];
  const kept = new Set();
  reply.guests.forEach((g, i) => {
    if (photos.has(i)) { g.photo = photos.get(i); return; }
    // No new photo: keep the one this person sent before, matched by name.
    const match = oldGuests.find((o) => o.photo && !kept.has(o.photo.id) && normName(o.name) === normName(g.name));
    if (match) { g.photo = match.photo; kept.add(match.photo.id); }
  });
  const now = new Date().toISOString();
  await store.put('rsvps', id, { ...reply, createdAt: old?.createdAt || now, updatedAt: now });
  await dropPhotos(oldGuests.map((g) => g.photo).filter((p) => p && !kept.has(p.id)));
  return { updated: !!old };
}

app.post('/api/rsvp', limit('rsvp', 30, 60 * 60_000), json, async (req, res) => {
  if (!req.is('multipart/form-data')) {
    const { reply, error } = checkRsvp(req.body);
    if (error) return res.status(400).json({ error });
    try { res.json({ ok: true, ...(await saveRsvp(reply, new Map())) }); }
    catch (err) { console.error('rsvp', err); res.status(500).json({ error: 'Your reply did not save. Try again in a moment.' }); }
    return;
  }
  const form = await readRsvpForm(req);
  const uploaded = [...form.photos.values()];
  const fail = async (status, error) => { await dropPhotos(uploaded); if (!res.headersSent) res.status(status).json({ error }); };
  if (form.failed) return fail(400, 'The reply was interrupted. Try again.');
  const { reply, error } = checkRsvp(form.data);
  if (error) return fail(400, error);
  if (form.problems.length) {
    const { index, why } = form.problems[0];
    const who = reply.guests[index]?.name || `paddler ${index + 1}`;
    return fail(400, why === 'size' ? `The photo for ${who} is too big. Pick one under 25 MB.`
      : why === 'type' ? `The photo for ${who} needs to be a picture file.`
      : `The photo for ${who} did not upload. Try again.`);
  }
  // Photos for paddlers who are not in the reply (or for a "no") are not kept.
  const usable = new Map([...form.photos].filter(([i]) => i < reply.guests.length));
  await dropPhotos([...form.photos].filter(([i]) => i >= reply.guests.length).map(([, p]) => p));
  try {
    res.json({ ok: true, ...(await saveRsvp(reply, usable)) });
  } catch (err) {
    console.error('rsvp', err);
    await dropPhotos([...usable.values()]);
    res.status(500).json({ error: 'Your reply did not save. Try again in a moment.' });
  }
});

/* ----- guest photo upload ----- */

app.post('/api/upload', limit('upload', 60, 60 * 60_000), (req, res) => {
  if (!uploadsEnabled) return res.status(503).json({ error: 'Photo uploads are not switched on yet.' });
  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { files: MAX_FILES_PER_REQUEST, fileSize: MAX_UPLOAD_BYTES, fields: 5 } });
  } catch {
    return res.status(400).json({ error: 'Send the photos as a form upload.' });
  }
  let by = '';
  const saved = [], skipped = [], pending = [];
  busboy.on('field', (name, value) => { if (name === 'name') by = clean(value, 120); });
  busboy.on('file', (field, stream, info) => {
    const type = (info.mimeType || '').toLowerCase();
    if (!/^(image|video)\//.test(type)) { skipped.push(info.filename || 'file'); stream.resume(); return; }
    const id = newId();
    const ext = (path.extname(info.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '').slice(0, 8);
    const day = new Date().toISOString().slice(0, 10);
    const key = `uploads/${day}/${id}${ext}`;
    let size = 0, tooBig = false;
    stream.on('data', (chunk) => { size += chunk.length; });
    stream.on('limit', () => { tooBig = true; });
    pending.push(
      putObject(key, stream, type)
        .then(async () => {
          if (tooBig) { await deleteObject(key); skipped.push(info.filename || 'file'); return; }
          await store.put('uploads', id, { key, type, size, filename: clean(info.filename, 200), by, createdAt: new Date().toISOString() });
          saved.push(id);
        })
        .catch((error) => { console.error('upload', error); skipped.push(info.filename || 'file'); })
    );
  });
  busboy.on('error', (error) => { console.error('busboy', error); if (!res.headersSent) res.status(400).json({ error: 'The upload was interrupted. Try again.' }); });
  busboy.on('close', async () => {
    await Promise.all(pending);
    if (res.headersSent) return;
    if (!saved.length) return res.status(400).json({ error: skipped.length ? 'Those files could not be saved. Photos and videos only, up to 300 MB each.' : 'Choose at least one photo.', skipped });
    res.json({ ok: true, saved: saved.length, skipped });
  });
  req.pipe(busboy);
});

async function sendObject(res, key, type) {
  if (s3) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET, Key: key }), { expiresIn: 3600 });
    return res.redirect(302, url);
  }
  if (localDir) return res.type(type).sendFile(path.join(localDir, key.replace(/\//g, '_')));
  res.status(404).end();
}

// Admin only for now: there is no public gallery yet.
app.get('/media/:id', requireAdmin, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const doc = await store.get('uploads', req.params.id);
  if (!doc) return res.status(404).end();
  await sendObject(res, doc.key, doc.type);
});

// RSVP photos: Admin only.
app.get('/rsvp-photo/:rsvp/:photo', requireAdmin, async (req, res) => {
  const { rsvp, photo } = req.params;
  if (!ID_RE.test(rsvp) || !ID_RE.test(photo)) return res.status(404).end();
  const doc = await store.get('rsvps', rsvp);
  const p = (Array.isArray(doc?.guests) ? doc.guests : []).map((g) => g.photo).find((x) => x && x.id === photo);
  if (!p) return res.status(404).end();
  await sendObject(res, p.key, p.type);
});

/* ----- admin ----- */

app.get('/api/admin/rsvps', requireAdmin, async (req, res) => {
  const rows = (await store.list('rsvps')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.setHeader('Cache-Control', 'no-store');
  res.json(rows);
});
app.get('/api/admin/rsvps.csv', requireAdmin, async (req, res) => {
  const rows = (await store.list('rsvps')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + s.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""') + '"' : s; };
  const AGE = { keiki: 'Kid (keiki)', adult: 'Adult (big kahuna)', kupuna: 'Senior (kupuna)' };
  const lines = [['Reply from', 'Coming', 'Party size', 'Guest', 'Age group', 'Comment', 'Photo', 'First replied', 'Last changed'].join(',')];
  for (const r of rows) {
    const guests = Array.isArray(r.guests) && r.guests.length ? r.guests : [null];
    for (const g of guests) {
      lines.push([r.name, r.attending, r.count, g?.name, g ? AGE[g.age] : '', g?.comment, g ? (g.photo ? 'yes' : 'no') : '', r.createdAt, r.updatedAt].map(esc).join(','));
    }
  }
  res.setHeader('Content-Disposition', 'attachment; filename="rsvps.csv"');
  res.type('text/csv').send(lines.join('\n') + '\n');
});
app.delete('/api/admin/rsvps/:id', requireAdmin, async (req, res) => {
  const doc = ID_RE.test(req.params.id) ? await store.get('rsvps', req.params.id) : null;
  if (!doc) return res.status(404).json({ error: 'That reply is already gone.' });
  await dropPhotos((Array.isArray(doc.guests) ? doc.guests : []).map((g) => g.photo).filter(Boolean));
  await store.del('rsvps', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/uploads', requireAdmin, async (req, res) => {
  const rows = (await store.list('uploads')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.setHeader('Cache-Control', 'no-store');
  res.json(rows);
});
app.delete('/api/admin/uploads/:id', requireAdmin, async (req, res) => {
  const doc = ID_RE.test(req.params.id) ? await store.get('uploads', req.params.id) : null;
  if (!doc) return res.status(404).json({ error: 'That photo is already gone.' });
  try { await deleteObject(doc.key); } catch (error) { console.error('delete object', error); }
  await store.del('uploads', req.params.id);
  res.json({ ok: true });
});

function checkDoc(req, res) {
  const { collection, id } = req.params;
  if (!PUBLIC_COLLECTIONS.includes(collection)) { res.status(400).json({ error: 'Unknown section.' }); return null; }
  if (id !== undefined && !ID_RE.test(id)) { res.status(400).json({ error: 'Bad id.' }); return null; }
  const body = req.body;
  if (req.method !== 'DELETE') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: 'Nothing to save.' }); return null; }
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_DOC_BYTES) { res.status(413).json({ error: 'That is too large to save. Use a smaller photo.' }); return null; }
  }
  return body;
}
app.post('/api/admin/:collection', requireAdmin, json, async (req, res) => {
  const body = checkDoc(req, res); if (!body) return;
  const id = newId();
  await store.put(req.params.collection, id, body);
  res.json({ ok: true, id });
});
app.put('/api/admin/:collection/:id', requireAdmin, json, async (req, res) => {
  const body = checkDoc(req, res); if (!body) return;
  await store.put(req.params.collection, req.params.id, body);
  res.json({ ok: true });
});
app.delete('/api/admin/:collection/:id', requireAdmin, async (req, res) => {
  if (checkDoc(req, res) === null && res.headersSent) return;
  await store.del(req.params.collection, req.params.id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'That is too large to save.' : 'Something went wrong. Try again.' });
});

// One-time content updates shipped with the code. Each runs once and backs up what it replaces.
async function migrateOnce(name, run) {
  if (await store.get('meta', name)) return;
  await run();
  await store.put('meta', name, { at: new Date().toISOString() });
  console.log(`Applied content update: ${name}`);
}

await store.init();
await seedOnce();
// Our Story rewritten as a shared story. The earlier chapters are kept in story_backup_v1.
await migrateOnce('story-v2', async () => {
  const next = JSON.parse(fs.readFileSync(path.join(here, 'content', 'story-v2.json'), 'utf8'));
  for (const doc of await store.list('story')) {
    const { id, ...data } = doc;
    await store.put('story_backup_v1', id, data);
    await store.del('story', id);
  }
  for (const doc of next) await store.put('story', doc.id, doc.data);
});
app.listen(PORT, () => console.log(`Listening on ${PORT} (store: ${store.kind}, uploads: ${s3 ? 'bucket' : localDir ? 'local folder' : 'off'})`));
