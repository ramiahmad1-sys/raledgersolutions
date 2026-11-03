'use strict';
/* Email notifications over plain SMTP (no dependencies). Disabled unless SMTP_HOST and MAIL_FROM are set.
   Emails deliberately contain NO message text or file names: only who, what kind, how many, and a link. */
const net = require('node:net');
const tls = require('node:tls');
const { db } = require('./db');

const cfg = () => ({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === '1',
  user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.MAIL_FROM,
  insecure: process.env.SMTP_INSECURE === '1',                    // local testing only
  delay: Number(process.env.NOTIFY_DELAY_MS ?? 90000),            // batch window
  url: (process.env.PORTAL_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '') + '/portal/'
});
const enabled = () => { const c = cfg(); return !!(c.host && c.from); };
const clean = s => String(s).replace(/[\r\n]+/g, ' ').trim();
const addrOf = s => (clean(s).match(/<([^>]+)>/) || [, clean(s)])[1];

/* ---- minimal SMTP client ---- */
function smtpSend({ to, subject, text }) {
  const c = cfg();
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiting = null, done = false, upgraded = false;
    const fail = e => { if (!done) { done = true; try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); } };
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 30000);
    const finish = () => { if (!done) { done = true; clearTimeout(timer); sock.end(); resolve(); } };
    const onData = d => {
      buf += d.toString('utf8');
      for (;;) {                                           // a reply ends at a line like "250 text" (space after code)
        const m = buf.match(/^(?:\d{3}-.*\r?\n)*\d{3} .*\r?\n/);
        if (!m) return;
        const reply = m[0]; buf = buf.slice(reply.length);
        const w = waiting; waiting = null; if (w) w(reply);
      }
    };
    const attach = s => { sock = s; s.on('data', onData); s.on('error', fail); s.on('close', () => { if (!done) fail(new Error('SMTP connection closed')); }); };
    const read = () => new Promise(r => { waiting = r; if (buf) onData(''); });
    const cmd = async (line, ok) => {
      if (line != null) sock.write(line + '\r\n');
      const r = await read(), code = Number(r.slice(0, 3));
      if (!ok.includes(code)) throw new Error('SMTP ' + clean(r).slice(0, 120));
      return r;
    };
    const run = async () => {
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO raledgersolutions.com', [250]);
      if (!c.secure && !c.insecure) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('Server does not offer STARTTLS; refusing to send unencrypted');
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners(); buf = '';
        await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: c.host }, res); t.once('error', rej); attach(t); upgraded = true; });
        ehlo = await cmd('EHLO raledgersolutions.com', [250]);
      }
      if (c.user) {
        const tok = Buffer.from('\0' + c.user + '\0' + c.pass).toString('base64');
        await cmd('AUTH PLAIN ' + tok, [235]);
      }
      await cmd(`MAIL FROM:<${addrOf(c.from)}>`, [250]);
      for (const a of to) await cmd(`RCPT TO:<${addrOf(a)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
      const msg = [`From: ${clean(c.from)}`, `To: ${to.map(clean).join(', ')}`,
        `Subject: =?UTF-8?B?${Buffer.from(clean(subject)).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64].join('\r\n');
      await cmd(msg + '\r\n.', [250]);
      await cmd('QUIT', [221]).catch(() => {});
      finish();
    };
    const start = () => run().catch(fail);
    if (c.secure) attach(tls.connect({ host: c.host, port: c.port, servername: c.host }, start));
    else { attach(net.connect({ host: c.host, port: c.port })); sock.once('connect', start); }
  });
}

/* ---- batching: one email per (recipient group, client, kind) per window ---- */
const pending = new Map();
function queue({ audience, clientId, kind }) {
  if (!enabled()) return;
  const key = [audience, clientId, kind].join('|');
  const p = pending.get(key);
  if (p) { p.n++; return; }
  const entry = { audience, clientId, kind, n: 1 };
  pending.set(key, entry);
  const t = setTimeout(() => { pending.delete(key); flush(entry).catch(e => console.error('Email notification failed:', e.message)); }, cfg().delay);
  t.unref?.();
}
function recipients(audience, clientId) {
  if (audience === 'staff') {
    const env = (process.env.NOTIFY_STAFF_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
    return env.length ? env : db.prepare("SELECT email FROM users WHERE role='staff'").all().map(r => r.email);
  }
  return db.prepare("SELECT email FROM users WHERE role='client' AND client_id=?").all(clientId).map(r => r.email);
}
async function flush({ audience, clientId, kind, n }) {
  const client = db.prepare('SELECT name FROM clients WHERE id=?').get(clientId);
  const to = recipients(audience, clientId);
  if (!client || !to.length) return;
  const noun = kind === 'message' ? (n === 1 ? 'a new message' : n + ' new messages')
    : kind === 'report' ? (n === 1 ? 'a new report' : n + ' new reports') : (n === 1 ? 'a new document' : n + ' new documents');
  const c = cfg(), name = clean(client.name);
  if (audience === 'staff') {
    await smtpSend({ to, subject: `${name}: ${noun}`, text: `${name} sent ${noun} in the client portal.\n\nSign in to view it: ${c.url}\n` });
  } else {
    await smtpSend({ to, subject: `RA Ledger Solutions: ${noun} for you`, text: `Hello ${name},\n\nYour accountant sent ${noun} in your client portal.\n\nSign in to view it: ${c.url}\n\nFor your security, this email does not include the contents. Please do not reply with sensitive information.\n` });
  }
}

/* Called by the server after a successful write. Never throws. */
function notify(actorRole, clientId, kind) {
  try { queue({ audience: actorRole === 'client' ? 'staff' : 'client', clientId, kind }); }
  catch (e) { console.error('Notify error:', e.message); }
}
module.exports = { notify, enabled, smtpSend };
