'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, checkPassword, hashPassword, createUser } = require('./db');
const { notify, enabled: mailEnabled } = require('./mail');
const billing = require('./billing');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIE = process.env.COOKIE_SECURE !== '0' && process.env.NODE_ENV === 'production';
const MAX_FILE = 15 * 1024 * 1024;
const SESSION_MS = 14 * 24 * 3600 * 1000;
const now = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* First-run bootstrap of the initial staff account from env vars. */
if (!db.prepare("SELECT 1 FROM users WHERE role='staff'").get()) {
  if (process.env.STAFF_EMAIL && process.env.STAFF_PASSWORD && process.env.STAFF_PASSWORD.length >= 10) {
    createUser({ email: process.env.STAFF_EMAIL, password: process.env.STAFF_PASSWORD, role: 'staff' });
    console.log('Created initial staff user', process.env.STAFF_EMAIL.toLowerCase());
  } else console.warn('No staff user exists. Run: npm run create-user -- staff <email> <password>');
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m = 'Bad request') => new HttpError(400, m);

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try { const v = JSON.parse(buf.toString() || '{}'); if (v && typeof v === 'object') return v; } catch {}
  throw bad('Invalid JSON');
}
const str = (v, max, { required = true } = {}) => {
  if (typeof v !== 'string') { if (required) throw bad(); return ''; }
  v = v.trim(); if ((required && !v) || v.length > max) throw bad();
  return v;
};
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));
}
function ip(req) { return (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress; }

/* ---------- sessions & login throttling ---------- */
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `ra_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function getUser(req) {
  const t = parseCookies(req).ra_session; if (!t) return null;
  const row = db.prepare(`SELECT u.id,u.email,u.role,u.client_id,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(t));
  if (!row) return null;
  if (row.expires < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t)); return null; }
  return row;
}
const attempts = new Map(); // key -> {n, reset}
function throttle(key) {
  const a = attempts.get(key);
  if (a && a.reset > Date.now() && a.n >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
}
function noteFail(key) {
  const a = attempts.get(key);
  if (!a || a.reset < Date.now()) attempts.set(key, { n: 1, reset: Date.now() + 15 * 60000 }); else a.n++;
}
setInterval(() => { for (const [k, v] of attempts) if (v.reset < Date.now()) attempts.delete(k); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); }, 600000).unref();

/* ---------- authorization ---------- */
const needStaff = u => { if (u.role !== 'staff') throw new HttpError(403, 'Forbidden'); };
function scopeClient(u, id) {       // clients are locked to their own company
  const cid = u.role === 'client' ? u.client_id : id;
  if (!cid || !db.prepare('SELECT 1 FROM clients WHERE id=?').get(cid)) throw new HttpError(404, 'Not found');
  return cid;
}
const ownFile = (u, id) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(id);
  if (!f || (u.role === 'client' && f.client_id !== u.client_id)) throw new HttpError(404, 'Not found');
  return f;
};
const ownRequest = (u, id) => {
  const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if (!r || (u.role === 'client' && r.client_id !== u.client_id)) throw new HttpError(404, 'Not found');
  return r;
};
const safeName = n => (n || 'file').replace(/[\\/\x00-\x1f"<>|?*:]/g, '_').replace(/^\.+/, '').slice(0, 150) || 'file';

/* ---------- API ---------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-requested-with'] !== 'ra-portal') throw new HttpError(403, 'Forbidden');

  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    const email = str(b.email, 200).toLowerCase(), pw = str(b.password, 200);
    const k1 = 'ip:' + ip(req), k2 = 'em:' + email;
    throttle(k1); throttle(k2);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    // always run scrypt so response time doesn't reveal whether the email exists
    const ok = checkPassword(pw, u ? u.pw : hashPassword('x'));
    if (!u || !ok) { noteFail(k1); noteFail(k2); throw new HttpError(401, 'Email or password is incorrect.'); }
    startSession(res, u.id);
    return send(res, 200, me(u));
  }
  if (p === '/api/logout' && m === 'POST') {
    const t = parseCookies(req).ra_session; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'ra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  const user = getUser(req);
  if (!user) throw new HttpError(401, 'Not signed in');
  const out = (v, s = 200) => send(res, s, v);

  if (p === '/api/me' && m === 'GET') return out(me(user));

  if (p === '/api/password' && m === 'POST') {
    const b = await readJson(req);
    const row = db.prepare('SELECT pw FROM users WHERE id=?').get(user.id);
    if (!checkPassword(str(b.current, 200), row.pw)) throw new HttpError(401, 'Current password is incorrect.');
    const np = str(b.password, 200); if (np.length < 10) throw bad('Password must be at least 10 characters.');
    db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPassword(np), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);   // sign out everywhere, incl. here
    startSession(res, user.id);
    return send(res, 200, { ok: true });
  }

  /* clients (staff) */
  if (p === '/api/clients' && m === 'GET') {
    needStaff(user);
    return out(db.prepare(`SELECT c.id,c.name,c.contact,c.created,c.notify, u.email,
      (SELECT COUNT(*) FROM files f WHERE f.client_id=c.id AND f.by='client') AS docs,
      (SELECT COUNT(*) FROM requests r WHERE r.client_id=c.id AND r.status='open') AS open_requests,
      (SELECT sender||': '||substr(text,1,40) FROM messages x WHERE x.client_id=c.id ORDER BY date DESC LIMIT 1) AS last_message
      FROM clients c LEFT JOIN users u ON u.client_id=c.id ORDER BY c.name COLLATE NOCASE`).all());
  }
  if (p === '/api/clients' && m === 'POST') {
    needStaff(user);
    const b = await readJson(req);
    const name = str(b.name, 150), contact = str(b.contact, 150, { required: false }), email = str(b.email, 200).toLowerCase(), pw = str(b.password, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email.');
    if (pw.length < 10) throw bad('Password must be at least 10 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'That email is already in use.');
    const id = crypto.randomUUID();
    db.exec('BEGIN');
    try { db.prepare('INSERT INTO clients (id,name,contact,created) VALUES (?,?,?,?)').run(id, name, contact, now()); createUser({ email, password: pw, role: 'client', clientId: id }); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return out({ id }, 201);
  }
  let mm;
  if ((mm = p.match(/^\/api\/clients\/([\w-]+)$/)) && m === 'DELETE') {
    needStaff(user); scopeClient(user, mm[1]);
    if (db.prepare('SELECT 1 FROM invoices WHERE client_id=? AND number IS NOT NULL').get(mm[1]))
      throw new HttpError(409, 'This client has invoice history, which must be kept for your records. Void open invoices instead of deleting the client.');
    const ids = db.prepare('SELECT id FROM files WHERE client_id=?').all(mm[1]);
    db.prepare('DELETE FROM clients WHERE id=?').run(mm[1]);         // cascades to users, files, requests, messages
    for (const f of ids) fs.rmSync(path.join(DATA_DIR, 'files', f.id), { force: true });
    return out({ ok: true });
  }
  if ((mm = p.match(/^\/api\/clients\/([\w-]+)\/password$/)) && m === 'POST') {   // staff reset of a client's password
    needStaff(user); scopeClient(user, mm[1]);
    const pw = str((await readJson(req)).password, 200); if (pw.length < 10) throw bad('Password must be at least 10 characters.');
    const r = db.prepare("UPDATE users SET pw=? WHERE client_id=? AND role='client'").run(hashPassword(pw), mm[1]);
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id=?)").run(mm[1]);
    return out({ ok: r.changes > 0 });
  }

  /* email notification preference: a client sets their own; staff can set any client's */
  if (p === '/api/notifications' && m === 'POST') {
    if (user.role !== 'client') throw new HttpError(403, 'Forbidden');
    const en = (await readJson(req)).enabled; if (typeof en !== 'boolean') throw bad();
    db.prepare('UPDATE clients SET notify=? WHERE id=?').run(en ? 1 : 0, user.client_id);
    return out({ enabled: en });
  }
  if ((mm = p.match(/^\/api\/clients\/([\w-]+)\/notifications$/)) && m === 'POST') {
    needStaff(user); scopeClient(user, mm[1]);
    const en = (await readJson(req)).enabled; if (typeof en !== 'boolean') throw bad();
    db.prepare('UPDATE clients SET notify=? WHERE id=?').run(en ? 1 : 0, mm[1]);
    return out({ enabled: en });
  }

  /* staff accounts (staff only) */
  if (p === '/api/staff' && m === 'GET') {
    needStaff(user);
    return out(db.prepare("SELECT id,email,created FROM users WHERE role='staff' ORDER BY email").all().map(r => ({ ...r, you: r.id === user.id })));
  }
  if (p === '/api/staff' && m === 'POST') {
    needStaff(user);
    const b = await readJson(req), email = str(b.email, 200).toLowerCase(), pw = str(b.password, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email.');
    if (pw.length < 10) throw bad('Password must be at least 10 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'That email is already in use.');
    return out({ id: createUser({ email, password: pw, role: 'staff' }) }, 201);
  }
  if ((mm = p.match(/^\/api\/staff\/([\w-]+)$/)) && m === 'DELETE') {
    needStaff(user);
    const t = db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(mm[1]);
    if (!t) throw new HttpError(404, 'Not found');
    if (t.id === user.id) throw bad('You cannot delete your own account.');
    db.prepare('DELETE FROM users WHERE id=?').run(t.id);            // sessions cascade, so they are signed out immediately
    return out({ ok: true });
  }
  if ((mm = p.match(/^\/api\/staff\/([\w-]+)\/password$/)) && m === 'POST') {
    needStaff(user);
    const t = db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(mm[1]);
    if (!t) throw new HttpError(404, 'Not found');
    if (t.id === user.id) throw bad('Use Account > Change password for your own password.');
    const pw = str((await readJson(req)).password, 200); if (pw.length < 10) throw bad('Password must be at least 10 characters.');
    db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPassword(pw), t.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
    return out({ ok: true });
  }

  /* everything for one client */
  if (p === '/api/data' && m === 'GET') {
    const cid = scopeClient(user, url.searchParams.get('clientId'));
    return out({
      client: db.prepare('SELECT id,name,contact,notify,fee_cents,fee_desc FROM clients WHERE id=?').get(cid),
      files: db.prepare('SELECT id,kind,name,size,period,note,by,date FROM files WHERE client_id=? ORDER BY date DESC, rowid DESC').all(cid),
      requests: db.prepare('SELECT * FROM requests WHERE client_id=?').all(cid),
      messages: db.prepare('SELECT id,sender,text,date FROM messages WHERE client_id=? ORDER BY date').all(cid)
    });
  }

  /* files */
  if (p === '/api/files' && m === 'POST') {
    const q = url.searchParams, cid = scopeClient(user, q.get('clientId'));
    const kind = user.role === 'client' ? 'doc' : (q.get('kind') === 'report' ? 'report' : 'doc');
    const period = q.get('period') || ''; if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('Bad period');
    const note = (q.get('note') || '').slice(0, 140);
    const len = Number(req.headers['content-length']);
    if (!len) throw bad('Empty file'); if (len > MAX_FILE) throw new HttpError(413, 'File is over 15 MB');
    const buf = await readBody(req, MAX_FILE);
    const id = crypto.randomUUID();
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
    fs.writeFileSync(path.join(DATA_DIR, 'files', id), buf);
    db.prepare('INSERT INTO files (id,client_id,kind,name,type,size,period,note,by,date) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, cid, kind, safeName(q.get('name')), type, buf.length, period, note, user.role, now());
    notify(user.role, cid, kind);
    return out({ id }, 201);
  }
  if ((mm = p.match(/^\/api\/files\/([\w-]+)$/))) {
    const f = ownFile(user, mm[1]);
    if (m === 'GET') {
      const data = fs.readFileSync(path.join(DATA_DIR, 'files', f.id));
      return send(res, 200, data, { 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Content-Security-Policy': "sandbox; default-src 'none'" });
    }
    if (m === 'DELETE') {
      if (user.role === 'client' && f.by !== 'client') throw new HttpError(403, 'Forbidden');
      db.prepare('DELETE FROM files WHERE id=?').run(f.id); fs.rmSync(path.join(DATA_DIR, 'files', f.id), { force: true });
      return out({ ok: true });
    }
  }

  /* requests */
  if (p === '/api/requests' && m === 'POST') {
    needStaff(user);
    const b = await readJson(req), cid = scopeClient(user, b.clientId);
    const due = str(b.due, 10, { required: false }); if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw bad('Bad date');
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO requests (id,client_id,title,due,status,created) VALUES (?,?,?,?,?,?)').run(id, cid, str(b.title, 200), due, 'open', now());
    return out({ id }, 201);
  }
  if ((mm = p.match(/^\/api\/requests\/([\w-]+)$/))) {
    const r = ownRequest(user, mm[1]);
    if (m === 'PATCH') {
      const s = (await readJson(req)).status; if (s !== 'open' && s !== 'done') throw bad();
      db.prepare('UPDATE requests SET status=? WHERE id=?').run(s, r.id); return out({ ok: true });
    }
    if (m === 'DELETE') { needStaff(user); db.prepare('DELETE FROM requests WHERE id=?').run(r.id); return out({ ok: true }); }
  }

  /* messages */
  if (p === '/api/messages' && m === 'POST') {
    const b = await readJson(req), cid = scopeClient(user, b.clientId);
    db.prepare('INSERT INTO messages (id,client_id,sender,text,date) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), cid, user.role, str(b.text, 4000), now());
    notify(user.role, cid, 'message');
    return out({ ok: true }, 201);
  }
  if (await billing.handle({ req, m, p, url, user, readJson, out, str, bad, HttpError, needStaff, scopeClient })) return;
  throw new HttpError(404, 'Not found');
}
const me = u => {
  const c = u.client_id ? db.prepare('SELECT name,notify FROM clients WHERE id=?').get(u.client_id) : null;
  return { role: u.role, email: u.email, clientId: u.client_id || null, name: c?.name ?? null, notify: c ? !!c.notify : null };
};

/* ---------- static site ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const BLOCKED = new Set(['server', 'data', 'node_modules', 'package.json', 'package-lock.json']);
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let rel; try { rel = decodeURIComponent(url.pathname); } catch { throw bad(); }
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(s => s.startsWith('.') || s === '..') || BLOCKED.has(parts[0])) throw new HttpError(404, 'Not found');
  let file = path.join(ROOT, ...parts);
  const tryFiles = [file, file + '.html', path.join(file, 'index.html')];
  file = tryFiles.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file || !file.startsWith(ROOT + path.sep) || !MIME[path.extname(file)]) throw new HttpError(404, 'Not found');
  const h = { 'Content-Type': MIME[path.extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' };
  if (parts[0] === 'portal') Object.assign(h, { 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" });
  res.writeHead(200, h); req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); return send(res, 200, 'ok'); }
    if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});
if (require.main === module) server.listen(PORT, process.env.HOST || undefined, () => console.log(`RA Ledger Solutions on http://localhost:${PORT} (email notifications ${mailEnabled() ? 'on' : 'off'})`));
module.exports = server;
