'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');

// tiny fake SMTP server that records each delivered message
const inbox = [];
const smtp = net.createServer(sock => {
  let data = false, cur = { rcpt: [], body: '' }, buf = '';
  sock.write('220 fake\r\n');
  sock.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (line === '.') { data = false; inbox.push(cur); cur = { rcpt: [], body: '' }; sock.write('250 queued\r\n'); } else cur.body += line + '\n'; continue; }
      if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH PLAIN/.test(line)) { cur.auth = Buffer.from(line.slice(11), 'base64').toString(); sock.write('235 ok\r\n'); }
      else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
      else if (/^RCPT TO:<(.+)>/.test(line)) { cur.rcpt.push(line.match(/<(.+)>/)[1]); sock.write('250 ok\r\n'); }
      else if (line === 'DATA') { data = true; sock.write('354 go\r\n'); }
      else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
    }
  });
});

let server, base;
test.before(async () => {
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ra-mail-')), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port),
    SMTP_INSECURE: '1', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'RA Ledger <no-reply@ra.test>', NOTIFY_DELAY_MS: '100', PORTAL_URL: 'https://example.test' });
  const { createUser } = require('./db');
  createUser({ email: 'staff@ra.test', password: 'staff-password-1', role: 'staff' });
  server = require('./server');
  await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); smtp.close(); });

const call = async (method, p, { cookie, json, raw } = {}) => {
  const headers = { 'X-Requested-With': 'ra-portal', ...(cookie ? { Cookie: cookie } : {}) }; let body;
  if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; } if (raw) { body = raw; headers['Content-Type'] = 'text/plain'; }
  const r = await fetch(base + p, { method, headers, body }); return { status: r.status, data: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] };
};
const login = async (e, p) => (await call('POST', '/api/login', { json: { email: e, password: p } })).cookie;
const wait = ms => new Promise(r => setTimeout(r, ms));
const text = m => { const b = m.body.split('\n'); const i = b.indexOf(''); return Buffer.from(b.slice(i + 1).join(''), 'base64').toString('utf8'); };
const subject = m => Buffer.from(m.body.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1], 'base64').toString('utf8');

test('uploads and messages email the other side, batched, with no content leaked', async () => {
  const staff = await login('staff@ra.test', 'staff-password-1');
  const id = (await call('POST', '/api/clients', { cookie: staff, json: { name: 'Acme\r\nBcc: evil@x.test', email: 'a@acme.test', password: 'acme-password-1' } })).data.id;
  const cl = await login('a@acme.test', 'acme-password-1');

  // client uploads 3 files + sends 1 message quickly -> 2 emails to staff (one per kind), not 4
  for (const n of ['secret1.pdf', 'secret2.pdf', 'secret3.pdf']) await call('POST', `/api/files?name=${n}`, { cookie: cl, raw: 'x' });
  await call('POST', '/api/messages', { cookie: cl, json: { clientId: id, text: 'my SSN is 123-45-6789' } });
  await wait(600);
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every(m => m.rcpt.join() === 'staff@ra.test' && m.auth === '\0u\0p'));
  const subjects = inbox.map(subject).sort();
  assert.ok(subjects.some(s => /3 new documents/.test(s)) && subjects.some(s => /a new message/.test(s)));
  assert.ok(subjects.every(s => !/[\r\n]/.test(s)), 'subject stays on one line');
  const all = inbox.map(m => m.body + text(m)).join('\n');
  assert.ok(!/secret\d|SSN|123-45/.test(all), 'no file names or message text in email');
  assert.ok(!/^Bcc:/m.test(all), 'header injection blocked');
  assert.ok(inbox.map(text).every(t => t.includes('https://example.test/portal/')));

  // staff publishes a report + replies -> client is emailed
  inbox.length = 0;
  await call('POST', `/api/files?clientId=${id}&kind=report&name=pl.pdf`, { cookie: staff, raw: 'x' });
  await call('POST', '/api/messages', { cookie: staff, json: { clientId: id, text: 'thanks' } });
  await wait(600);
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every(m => m.rcpt.join() === 'a@acme.test'));
});

test('a mail failure never breaks the request', async () => {
  const staff = await login('staff@ra.test', 'staff-password-1');
  const id = (await call('POST', '/api/clients', { cookie: staff, json: { name: 'Beta', email: 'b@beta.test', password: 'beta-password-1' } })).data.id;
  const saved = process.env.SMTP_PORT; process.env.SMTP_PORT = '1';        // nothing listens here
  const r = await call('POST', '/api/messages', { cookie: staff, json: { clientId: id, text: 'hi' } });
  assert.equal(r.status, 201); await wait(500); process.env.SMTP_PORT = saved;
});

test('per-client email opt-out', async () => {
  const staff = await login('staff@ra.test', 'staff-password-1');
  const id = (await call('POST', '/api/clients', { cookie: staff, json: { name: 'Delta', email: 'd@delta.test', password: 'delta-password-1' } })).data.id;
  const cl = await login('d@delta.test', 'delta-password-1');
  assert.equal((await call('GET', '/api/me', { cookie: cl })).data.notify, true);          // default on

  assert.equal((await call('POST', '/api/notifications', { cookie: cl, json: { enabled: 'no' } })).status, 400);
  assert.equal((await call('POST', '/api/notifications', { cookie: staff, json: { enabled: false } })).status, 403);   // staff use the per-client route
  assert.equal((await call('POST', '/api/notifications', { cookie: cl, json: { enabled: false } })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: cl })).data.notify, false);
  assert.equal((await call('GET', '/api/clients', { cookie: staff })).data.find(c => c.id === id).notify, 0);

  inbox.length = 0;
  await call('POST', '/api/messages', { cookie: staff, json: { clientId: id, text: 'hello' } });          // would email the client
  await call('POST', '/api/messages', { cookie: cl, json: { clientId: id, text: 'reply' } });             // still emails staff
  await wait(600);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].rcpt.join(), 'staff@ra.test');

  // staff can turn it back on for the client; a client cannot touch another client's setting
  assert.equal((await call('POST', `/api/clients/${id}/notifications`, { cookie: cl, json: { enabled: true } })).status, 403);
  assert.equal((await call('POST', `/api/clients/${id}/notifications`, { cookie: staff, json: { enabled: true } })).status, 200);
  inbox.length = 0;
  await call('POST', '/api/messages', { cookie: staff, json: { clientId: id, text: 'again' } });
  await wait(600);
  assert.equal(inbox.length, 1); assert.equal(inbox[0].rcpt.join(), 'd@delta.test');
});
