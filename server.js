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
app.post('/api/rsvp', limit('rsvp', 30, 60 * 60_000), json, async (req, res) => {
  const name = clean(req.body?.name, 120);
  const attending = req.body?.attending === 'yes' ? 'yes' : req.body?.attending === 'no' ? 'no' : '';
  let count = parseInt(req.body?.count, 10);
  if (!name) return res.status(400).json({ error: 'Add your name so we know who is replying.' });
  if (!attending) return res.status(400).json({ error: 'Choose yes or no.' });
  if (attending === 'no') count = 0;
  else if (!(count >= 1)) count = 1;
  count = Math.min(count, 20);
  const id = crypto.createHash('sha256').update(name.toLowerCase().replace(/\s+/g, ' ')).digest('base64url').slice(0, 22);
  try {
    const old = await store.get('rsvps', id);
    await store.put('rsvps', id, {
      name, attending, count,
      createdAt: old?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true, updated: !!old });
  } catch (error) {
    console.error('rsvp', error);
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

// Admin only for now: there is no public gallery yet.
app.get('/media/:id', requireAdmin, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).end();
  const doc = await store.get('uploads', req.params.id);
  if (!doc) return res.status(404).end();
  if (s3) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET, Key: doc.key }), { expiresIn: 3600 });
    return res.redirect(302, url);
  }
  if (localDir) return res.type(doc.type).sendFile(path.join(localDir, doc.key.replace(/\//g, '_')));
  res.status(404).end();
});

/* ----- admin ----- */

app.get('/api/admin/rsvps', requireAdmin, async (req, res) => {
  const rows = (await store.list('rsvps')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.setHeader('Cache-Control', 'no-store');
  res.json(rows);
});
app.get('/api/admin/rsvps.csv', requireAdmin, async (req, res) => {
  const rows = (await store.list('rsvps')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : s; };
  const lines = [['Name', 'Coming', 'Party size', 'First replied', 'Last changed'].join(',')]
    .concat(rows.map((r) => [r.name, r.attending, r.count, r.createdAt, r.updatedAt].map(esc).join(',')));
  res.setHeader('Content-Disposition', 'attachment; filename="rsvps.csv"');
  res.type('text/csv').send(lines.join('\n') + '\n');
});
app.delete('/api/admin/rsvps/:id', requireAdmin, async (req, res) => {
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

await store.init();
await seedOnce();
app.listen(PORT, () => console.log(`Listening on ${PORT} (store: ${store.kind}, uploads: ${s3 ? 'bucket' : localDir ? 'local folder' : 'off'})`));
