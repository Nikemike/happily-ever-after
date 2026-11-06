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
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import sharp from 'sharp';
import exifr from 'exifr';
import ffmpegPath from 'ffmpeg-static';
import UAParser from 'ua-parser-js';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3000);

const PUBLIC_COLLECTIONS = ['quotes', 'story', 'details', 'faq', 'awards', 'notes', 'cats', 'pages'];
// Sections hidden from guests for now. Their content is kept and still shows for Admin.
// The page hides a section's tab when it has nothing to show, so guests see no tab at all.
// To bring Our Story back, remove 'story' from this list.
const HIDDEN_FROM_GUESTS = ['story'];
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
  if (Buffer.isBuffer(stream)) { fs.writeFileSync(file, stream); return; }
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
async function getObjectToFile(key, file) {
  if (s3) {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET, Key: key }));
    await pipeline(out.Body, fs.createWriteStream(file));
    return;
  }
  fs.copyFileSync(path.join(localDir, key.replace(/\//g, '_')), file);
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

// What we record about the phone or computer that sent something (Admin only).
// `hints` comes from the page: a random device ID kept on that device, screen size, and on
// Chrome-based browsers the real model and OS version (their user-agent string hides them).
function deviceTags(req, hints) {
  if (typeof hints === 'string') { try { hints = JSON.parse(hints); } catch { hints = {}; } }
  if (!hints || typeof hints !== 'object') hints = {};
  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  const p = UAParser(ua);
  const model = clean(hints.model, 60) || [p.device.vendor, p.device.model].filter(Boolean).join(' ');
  const osName = clean(hints.platform, 40) || p.os.name || '';
  let osVersion = p.os.version || '';
  const hv = clean(hints.platformVersion, 20);
  if (hv && /android|mac/i.test(osName)) osVersion = hv.replace(/(\.0)+$/, '');
  if (hv && /windows/i.test(osName)) osVersion = parseInt(hv, 10) >= 13 ? '11' : '10';
  const browser = [p.browser.name, p.browser.major].filter(Boolean).join(' ');
  const kind = p.device.type || 'computer';
  return {
    summary: [model || (kind === 'computer' ? 'Computer' : kind), [osName, osVersion].filter(Boolean).join(' '), browser].filter(Boolean).join(' · '),
    model, os: osName, osVersion, browser, kind,
    screen: clean(hints.screen, 24),
    id: /^[A-Za-z0-9_-]{8,40}$/.test(hints.id || '') ? hints.id : '',
    ip: req.ip || '',
    forwardedFor: clean(req.headers['x-forwarded-for'], 200),
    userAgent: ua,
  };
}

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
    const admin = isAdmin(req);
    for (const c of PUBLIC_COLLECTIONS) out[c] = HIDDEN_FROM_GUESTS.includes(c) && !admin ? [] : await store.list(c);
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
    reply.device = deviceTags(req, req.body?.device);
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
  reply.device = deviceTags(req, form.data?.device);
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
    busboy = Busboy({ headers: req.headers, limits: { files: MAX_FILES_PER_REQUEST + 1, fileSize: MAX_UPLOAD_BYTES, fields: 5, fieldSize: 8 * 1024 } });
  } catch {
    return res.status(400).json({ error: 'Send the photos as a form upload.' });
  }
  let by = '', hints = {}, preview = null;
  const saved = [], skipped = [], pending = [];
  const day = new Date().toISOString().slice(0, 10);
  busboy.on('field', (name, value) => {
    if (name === 'name') by = clean(value, 120);
    if (name === 'device') { try { hints = JSON.parse(value); } catch { hints = {}; } }
  });
  busboy.on('file', (field, stream, info) => {
    const type = (info.mimeType || '').toLowerCase();
    // A JPEG copy the browser made of a photo the server cannot read itself (iPhone HEIC).
    if (field === 'preview') {
      if (type !== 'image/jpeg' || preview) { stream.resume(); return; }
      const p = { key: `previews/${day}/${newId()}.jpg`, tooBig: false };
      preview = p;
      stream.on('limit', () => { p.tooBig = true; });
      pending.push(putObject(p.key, stream, type).catch((error) => { console.error('preview', error); stream.resume(); p.failed = true; }));
      return;
    }
    if (!/^(image|video)\//.test(type)) { skipped.push(info.filename || 'file'); stream.resume(); return; }
    const id = newId();
    const ext = (path.extname(info.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '').slice(0, 8);
    const key = `uploads/${day}/${id}${ext}`;
    let size = 0, tooBig = false;
    stream.on('data', (chunk) => { size += chunk.length; });
    stream.on('limit', () => { tooBig = true; });
    pending.push(
      putObject(key, stream, type)
        .then(async () => {
          if (tooBig) { await deleteObject(key); skipped.push(info.filename || 'file'); return; }
          await store.put('uploads', id, {
            key, type, size, filename: clean(info.filename, 200), by, createdAt: new Date().toISOString(),
            device: deviceTags(req, hints), status: 'processing',
          });
          saved.push(id);
        })
        .catch((error) => { console.error('upload', error); stream.resume(); skipped.push(info.filename || 'file'); })
    );
  });
  busboy.on('error', (error) => { console.error('busboy', error); if (!res.headersSent) res.status(400).json({ error: 'The upload was interrupted. Try again.' }); });
  busboy.on('close', async () => {
    await Promise.all(pending);
    // The browser's copy belongs to the one file it was sent with.
    if (preview && !preview.failed) {
      if (saved.length === 1 && !preview.tooBig) {
        const doc = await store.get('uploads', saved[0]);
        if (doc) { const { id, ...data } = doc; await store.put('uploads', id, { ...data, preview: { key: preview.key } }); }
      } else {
        await deleteObject(preview.key).catch(() => {});
      }
    }
    saved.forEach(enqueue);
    if (res.headersSent) return;
    if (!saved.length) return res.status(400).json({ error: skipped.length ? 'Those files could not be saved. Photos and videos only, up to 300 MB each.' : 'Choose at least one photo.', skipped });
    res.json({ ok: true, saved: saved.length, skipped });
  });
  req.pipe(busboy);
});

/* ----- making the public, location-free copies ----- */

// Photos: re-encoded by sharp, which drops all metadata (GPS included). Videos: copied by
// ffmpeg with all metadata and data tracks left out. Originals stay private (Admin only).
const queue = [];
let working = false;
function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  if (!working) work();
}
async function work() {
  working = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processUpload(id); } catch (error) { console.error('process', id, error); }
  }
  working = false;
}

function run(args, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args]);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 200_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, out, err: String(error) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const exifTime = (v) => {
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d)/.exec(String(v || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
};
function cameraFrom(make, model, lens, taken) {
  make = clean(String(make || ''), 60); model = clean(String(model || ''), 80);
  const name = model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
  const out = {};
  if (name) out.model = name;
  if (lens) out.lens = clean(String(lens), 100);
  if (taken) out.taken = taken;
  return out;
}

async function imageCopies(input, base) {
  const view = await sharp(input, { failOn: 'none' }).rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(view.data).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 74, mozjpeg: true }).toBuffer();
  await putObject(base + '.jpg', view.data, 'image/jpeg');
  await putObject(base + '-thumb.jpg', thumb, 'image/jpeg');
  return {
    public: { key: base + '.jpg', type: 'image/jpeg', size: view.info.size, width: view.info.width, height: view.info.height },
    thumb: { key: base + '-thumb.jpg', type: 'image/jpeg' },
  };
}

async function processImage(doc, src, tmp, base) {
  let camera = {};
  try {
    const t = await exifr.parse(src, { pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal'], reviveValues: false });
    if (t) camera = cameraFrom(t.Make, t.Model, t.LensModel, [exifTime(t.DateTimeOriginal || t.CreateDate), t.OffsetTimeOriginal].filter(Boolean).join(' '));
  } catch { /* no readable photo details */ }
  let input = src;
  let readable = await sharp(src).metadata().then(() => true, () => false);
  if (!readable && doc.preview) {
    input = path.join(tmp, 'preview.jpg');
    await getObjectToFile(doc.preview.key, input);
    readable = await sharp(input).metadata().then(() => true, () => false);
  }
  if (!readable) return { camera, status: 'private', reason: 'Not in the gallery: this file type could not be turned into a location-free copy.' };
  return { camera, status: 'public', ...(await imageCopies(input, base)) };
}

async function processVideo(doc, src, tmp, base) {
  const meta = await run(['-i', src, '-f', 'ffmetadata', '-']);
  const tags = {};
  for (const line of meta.out.split('\n')) { const i = line.indexOf('='); if (i > 0) tags[line.slice(0, i).toLowerCase()] = line.slice(i + 1); }
  const camera = cameraFrom(tags['com.apple.quicktime.make'] || tags.make, tags['com.apple.quicktime.model'] || tags.model, '',
    exifTime(tags['com.apple.quicktime.creationdate'] || tags.creation_time));
  const vcodec = (/Stream #\S+?: Video: (\w+)/.exec(meta.err) || [])[1] || '';
  if (!vcodec) return { camera, status: 'private', reason: 'Not in the gallery: the video could not be read.' };
  const common = ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1'];
  let out, type, args;
  if (['h264', 'hevc'].includes(vcodec)) {
    out = path.join(tmp, 'public.mp4'); type = 'video/mp4';
    args = [...common, '-c', 'copy', ...(vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', '-y', out];
  } else if (['vp8', 'vp9', 'av1'].includes(vcodec)) {
    out = path.join(tmp, 'public.webm'); type = 'video/webm';
    args = [...common, '-c', 'copy', '-y', out];
  } else {
    out = path.join(tmp, 'public.mp4'); type = 'video/mp4';
    args = [...common, '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', '-y', out];
  }
  let r = await run(['-i', src, ...args]);
  if (r.code !== 0 && args.includes('copy')) {
    // Audio that does not fit the container: keep the video as is, re-encode the sound.
    const i = args.indexOf('copy');
    args.splice(i - 1, 2, '-c:v', 'copy', '-c:a', type === 'video/webm' ? 'libopus' : 'aac');
    r = await run(['-i', src, ...args]);
  }
  if (r.code !== 0) { console.error('ffmpeg', r.err.slice(-800)); return { camera, status: 'private', reason: 'Not in the gallery: the video could not be converted.' }; }
  const frame = path.join(tmp, 'frame.jpg');
  let f = await run(['-ss', '0.5', '-i', out, '-frames:v', '1', '-y', frame], 120_000);
  if (f.code !== 0 || !fs.existsSync(frame)) f = await run(['-i', out, '-frames:v', '1', '-y', frame], 120_000);
  const size = fs.statSync(out).size;
  await putObject(base + path.extname(out), fs.createReadStream(out), type);
  const result = { camera, status: 'public', public: { key: base + path.extname(out), type, size } };
  if (fs.existsSync(frame)) {
    const thumb = await sharp(frame).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 74 }).toBuffer();
    await putObject(base + '-thumb.jpg', thumb, 'image/jpeg');
    const m = await sharp(frame).metadata();
    Object.assign(result.public, { width: m.width, height: m.height });
    result.thumb = { key: base + '-thumb.jpg', type: 'image/jpeg' };
  }
  return result;
}

async function processUpload(id) {
  const doc = await store.get('uploads', id);
  if (!doc || doc.status === 'public' || doc.status === 'private') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hea-'));
  let result;
  try {
    const src = path.join(tmp, 'original');
    await getObjectToFile(doc.key, src);
    const base = `public/${String(doc.createdAt || new Date().toISOString()).slice(0, 10)}/${id}`;
    result = doc.type.startsWith('video/') ? await processVideo(doc, src, tmp, base) : await processImage(doc, src, tmp, base);
  } catch (error) {
    console.error('process', id, error);
    result = { status: 'private', reason: 'Not in the gallery: something went wrong making the location-free copy.' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const fresh = await store.get('uploads', id);
  if (!fresh) { await dropUploadFiles(result); return; } // deleted while it was being processed
  const { id: _, ...data } = fresh;
  await store.put('uploads', id, { ...data, ...result, processedAt: new Date().toISOString() });
}

function uploadKeys(doc) {
  return [doc?.key, doc?.preview?.key, doc?.public?.key, doc?.thumb?.key].filter(Boolean);
}
async function dropUploadFiles(doc) {
  for (const key of uploadKeys(doc)) { try { await deleteObject(key); } catch (error) { console.error('delete object', error); } }
}

/* ----- public gallery ----- */

app.get('/api/photos', async (req, res) => {
  try {
    const rows = (await store.list('uploads'))
      .filter((u) => u.status === 'public' && u.public && u.thumb)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((u) => ({ id: u.id, kind: u.public.type.startsWith('video/') ? 'video' : 'image', by: u.by || '', at: u.createdAt, w: u.public.width || 0, h: u.public.height || 0 }));
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    console.error('photos', error);
    res.status(500).json({ error: 'The photos could not load.' });
  }
});

// Only the location-free copies are public.
app.get('/photo/:id/:size', async (req, res) => {
  const { id, size } = req.params;
  if (!ID_RE.test(id) || !['thumb', 'view'].includes(size)) return res.status(404).end();
  const doc = await store.get('uploads', id);
  const file = doc?.status === 'public' ? (size === 'thumb' ? doc.thumb : doc.public) : null;
  if (!file) return res.status(404).end();
  const download = size === 'view' && req.query.download === '1'
    ? `happily-ever-after-${id}${path.extname(file.key)}` : '';
  await sendObject(res, file.key, file.type, { download, cache: 600 });
});

async function sendObject(res, key, type, opts = {}) {
  if (opts.cache) res.setHeader('Cache-Control', `private, max-age=${opts.cache}`);
  const disposition = opts.download ? `attachment; filename="${opts.download}"` : undefined;
  if (s3) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET, Key: key, ResponseContentDisposition: disposition }), { expiresIn: 3600 });
    return res.redirect(302, url);
  }
  if (localDir) {
    if (disposition) res.setHeader('Content-Disposition', disposition);
    return res.type(type).sendFile(path.join(localDir, key.replace(/\//g, '_')));
  }
  res.status(404).end();
}

// Originals (which can hold GPS and camera details): Admin only.
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
  const AGE = { keiki: 'Little Kahuna (kid)', adult: 'Big Kahuna (adult)', kupuna: 'Elder (senior)' };
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
  await dropUploadFiles(doc);
  await store.del('uploads', req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/uploads/delete-device', requireAdmin, json, async (req, res) => {
  const device = typeof req.body?.device === 'string' ? req.body.device : '';
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(device)) return res.status(400).json({ error: 'No device chosen.' });
  const docs = (await store.list('uploads')).filter((u) => u.device?.id === device);
  for (const doc of docs) { await dropUploadFiles(doc); await store.del('uploads', doc.id); }
  res.json({ ok: true, deleted: docs.length });
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
// Startup self-check of the tools that make the location-free copies.
{
  const v = await run(['-version'], 20_000);
  console.log(v.code === 0 ? `Video tool ok: ${v.out.split('\n')[0]}` : `VIDEO TOOL MISSING: videos will stay out of the gallery (${v.err.slice(0, 200)})`);
  try {
    const probe = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    console.log(`Photo tool ok: sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}, test image ${probe.length} bytes`);
  } catch (error) { console.log('PHOTO TOOL BROKEN: ' + error.message); }
}
for (const u of await store.list('uploads')) if (u.status !== 'public' && u.status !== 'private') enqueue(u.id);
app.listen(PORT, () => console.log(`Listening on ${PORT} (store: ${store.kind}, uploads: ${s3 ? 'bucket' : localDir ? 'local folder' : 'off'})`));
