'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-test-'));
const { createUser } = require('./db');
const server = require('./server');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());

const H = { 'X-Requested-With': 'ra-portal' };
async function call(method, p, { cookie, json, raw, type } = {}) {
  const headers = { ...H, ...(cookie ? { Cookie: cookie } : {}) };
  let body;
  if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  if (raw) { body = raw; headers['Content-Type'] = type || 'text/plain'; }
  const r = await fetch(base + p, { method, headers, body });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0], headers: r.headers };
}
const login = async (email, password) => (await call('POST', '/api/login', { json: { email, password } })).cookie;

test('end to end with isolation between clients', async () => {
  createUser({ email: 'Staff@ra.test', password: 'staff-password-1', role: 'staff' });
  assert.equal((await call('GET', '/api/clients')).status, 401);
  assert.equal((await call('POST', '/api/login', { json: { email: 'staff@ra.test', password: 'nope' } })).status, 401);
  const staff = await login('staff@ra.test', 'staff-password-1'); assert.ok(staff);

  const a = (await call('POST', '/api/clients', { cookie: staff, json: { name: 'Acme', email: 'a@acme.test', password: 'acme-password-1' } })).data.id;
  const b = (await call('POST', '/api/clients', { cookie: staff, json: { name: 'Beta', email: 'b@beta.test', password: 'beta-password-1' } })).data.id;
  assert.equal((await call('POST', '/api/clients', { cookie: staff, json: { name: 'X', email: 'a@acme.test', password: 'xxxxxxxxxxx' } })).status, 409);

  const rep = await call('POST', `/api/files?clientId=${a}&kind=report&period=2026-03&name=pl.txt`, { cookie: staff, raw: 'profit', type: 'text/plain' });
  assert.equal(rep.status, 201);
  await call('POST', `/api/files?clientId=${b}&kind=report&name=beta-secret.txt`, { cookie: staff, raw: 'beta' });
  const req = (await call('POST', '/api/requests', { cookie: staff, json: { clientId: a, title: 'March stmt', due: '2026-04-10' } })).data.id;

  const ca = await login('a@acme.test', 'acme-password-1');
  const mine = (await call('GET', `/api/data?clientId=${b}`, { cookie: ca })).data;   // tries to ask for Beta's data
  assert.equal(mine.client.name, 'Acme');                                              // ignored; scoped to own company
  assert.deepEqual(mine.files.map(f => f.name), ['pl.txt']);
  assert.equal((await call('GET', '/api/files/' + rep.data.id, { cookie: ca })).data, 'profit');
  const betaFile = (await call('GET', `/api/data?clientId=${b}`, { cookie: staff })).data.files[0].id;
  assert.equal((await call('GET', '/api/files/' + betaFile, { cookie: ca })).status, 404);
  assert.equal((await call('GET', '/api/clients', { cookie: ca })).status, 403);
  assert.equal((await call('POST', '/api/requests', { cookie: ca, json: { clientId: a, title: 'x' } })).status, 403);
  assert.equal((await call('DELETE', '/api/files/' + rep.data.id, { cookie: ca })).status, 403);   // clients can't delete reports

  const up = await call('POST', '/api/files?clientId=' + b + '&kind=report&name=../../evil.txt', { cookie: ca, raw: 'doc' });
  assert.equal(up.status, 201);                                                         // forced to own company + kind=doc
  const d = (await call('GET', '/api/data', { cookie: ca })).data;
  const evil = d.files.find(f => f.by === 'client'); assert.equal(evil.kind, 'doc'); assert.ok(!evil.name.includes('/'));
  assert.equal((await call('PATCH', '/api/requests/' + req, { cookie: ca, json: { status: 'done' } })).status, 200);
  assert.equal((await call('POST', '/api/messages', { cookie: ca, json: { clientId: b, text: 'hello' } })).status, 201);
  assert.equal((await call('GET', `/api/data?clientId=${a}`, { cookie: staff })).data.messages[0].sender, 'client');

  // CSRF header required
  const noHdr = await fetch(base + '/api/messages', { method: 'POST', headers: { Cookie: ca, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHdr.status, 403);
  // path traversal & private files not served
  for (const u of ['/server/db.js', '/data/portal.db', '/package.json', '/../etc/passwd', '/.git/config', '/%2e%2e/server/db.js'])
    assert.ok([400, 404].includes((await fetch(base + u)).status), u);
  assert.equal((await fetch(base + '/services')).status, 200);
  assert.equal((await fetch(base + '/portal/')).status, 200);

  // password change & staff reset invalidate sessions
  assert.equal((await call('POST', '/api/password', { cookie: ca, json: { current: 'acme-password-1', password: 'short' } })).status, 400);
  await call('POST', `/api/clients/${a}/password`, { cookie: staff, json: { password: 'brand-new-pass-1' } });
  assert.equal((await call('GET', '/api/me', { cookie: ca })).status, 401);
  assert.ok(await login('a@acme.test', 'brand-new-pass-1'));

  // delete client removes files on disk
  const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'files')).length;
  await call('DELETE', '/api/clients/' + b, { cookie: staff });
  assert.ok(fs.readdirSync(path.join(process.env.DATA_DIR, 'files')).length < files);
});

test('login is throttled after repeated failures', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await call('POST', '/api/login', { json: { email: 'nobody@x.test', password: 'wrong' } });
  assert.equal(last.status, 429);
});
