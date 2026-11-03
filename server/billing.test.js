'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-billing-'));
const { createUser } = require('./db');
const server = require('./server');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => server.close());

async function call(method, p, { cookie, json } = {}) {
  const headers = { 'X-Requested-With': 'ra-portal', ...(cookie ? { Cookie: cookie } : {}) };
  let body; if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers, body });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
const login = async (e, pw) => (await call('POST', '/api/login', { json: { email: e, password: pw } })).cookie;
const draft = (clientId, over = {}) => ({ clientId, issueDate: '2026-11-01', dueDate: '2026-11-16',
  lines: [{ description: 'Monthly bookkeeping', qty: 1, unitCents: 45000 }, { description: 'Payroll runs', qty: 2.5, unitCents: 3333 }], ...over });

test('invoices: drafts, numbering, payments, voids and client visibility', async () => {
  createUser({ email: 'staff@ra.test', password: 'staff-password-1', role: 'staff' });
  const st = await login('staff@ra.test', 'staff-password-1');
  const a = (await call('POST', '/api/clients', { cookie: st, json: { name: 'Acme', email: 'a@acme.test', password: 'acme-password-1' } })).data.id;
  const b = (await call('POST', '/api/clients', { cookie: st, json: { name: 'Beta', email: 'b@beta.test', password: 'beta-password-1' } })).data.id;
  const ca = await login('a@acme.test', 'acme-password-1');

  // validation
  for (const bad of [{ lines: [] }, { dueDate: '2026-10-01' }, { issueDate: '2026-02-30' }, { payLink: 'javascript:alert(1)' }, { payLink: 'http://pay.example' },
    { lines: [{ description: 'x', qty: 0, unitCents: 100 }] }, { lines: [{ description: 'x', qty: 1.234, unitCents: 100 }] },
    { lines: [{ description: 'x', qty: 1, unitCents: 10.5 }] }, { lines: [{ description: 'disc', qty: 1, unitCents: -500 }] }])
    assert.equal((await call('POST', '/api/invoices', { cookie: st, json: draft(a, bad) })).status, 400, JSON.stringify(bad));

  // 450.00 + round(2.5 * 33.33) = 450.00 + 83.33 (8332.5 -> 8333 cents)
  const i1 = (await call('POST', '/api/invoices', { cookie: st, json: draft(a, { payLink: 'https://pay.example/inv' }) })).data.id;
  let inv = (await call('GET', '/api/invoices/' + i1, { cookie: st })).data;
  assert.equal(inv.total_cents, 53333); assert.equal(inv.state, 'draft'); assert.equal(inv.number, null);

  // clients never see drafts, and clients cannot use staff billing routes
  assert.equal((await call('GET', '/api/invoices', { cookie: ca })).data.length, 0);
  assert.equal((await call('GET', '/api/invoices/' + i1, { cookie: ca })).status, 404);
  for (const [m, pth, json] of [['POST', '/api/invoices', draft(a)], ['POST', `/api/invoices/${i1}/send`], ['POST', `/api/invoices/${i1}/payments`, {}],
    ['GET', '/api/billing/summary'], ['POST', '/api/billing/generate', { period: '2026-11' }], ['POST', `/api/clients/${a}/fee`, { feeCents: 1 }]])
    assert.equal((await call(m, pth, { cookie: ca, json })).status, 403, m + ' ' + pth);

  // edit a draft, then send: gets INV-0001; sent invoices are locked
  assert.equal((await call('PUT', '/api/invoices/' + i1, { cookie: st, json: draft(a, { payLink: 'https://pay.example/inv', lines: [{ description: 'Monthly bookkeeping', qty: 1, unitCents: 50000 }] }) })).status, 200);
  assert.equal((await call('POST', `/api/invoices/${i1}/send`, { cookie: st })).data.number, 'INV-0001');
  assert.equal((await call('POST', `/api/invoices/${i1}/send`, { cookie: st })).status, 400);
  assert.equal((await call('PUT', '/api/invoices/' + i1, { cookie: st, json: draft(a) })).status, 400);
  assert.equal((await call('DELETE', '/api/invoices/' + i1, { cookie: st })).status, 400);

  // the client now sees it, but not another client's invoices
  const i2 = (await call('POST', '/api/invoices', { cookie: st, json: draft(b) })).data.id;
  await call('POST', `/api/invoices/${i2}/send`, { cookie: st });
  const seen = (await call('GET', '/api/invoices?clientId=' + b, { cookie: ca })).data;   // clientId ignored for clients
  assert.deepEqual(seen.map(i => i.number), ['INV-0001']);
  assert.equal((await call('GET', '/api/invoices/' + i2, { cookie: ca })).status, 404);
  assert.equal((await call('GET', '/api/invoices/' + i1, { cookie: ca })).data.pay_link, 'https://pay.example/inv');

  // payments: partial, overpayment blocked, paid in full, delete restores balance
  const pay = (amountCents, extra = {}) => call('POST', `/api/invoices/${i1}/payments`, { cookie: st, json: { date: '2026-11-05', amountCents, method: 'check', reference: '1042', ...extra } });
  assert.equal((await pay(20000)).status, 201);
  inv = (await call('GET', '/api/invoices/' + i1, { cookie: st })).data;
  assert.equal(inv.state, 'partial'); assert.equal(inv.balance_cents, 30000);
  assert.equal((await pay(30001)).status, 400);
  assert.equal((await pay(100, { method: 'bitcoin' })).status, 400);
  assert.equal((await call('POST', `/api/invoices/${i1}/void`, { cookie: st })).status, 400);       // has payments
  assert.equal((await pay(30000, { method: 'ACH' })).status, 201);
  inv = (await call('GET', '/api/invoices/' + i1, { cookie: st })).data;
  assert.equal(inv.state, 'paid'); assert.equal(inv.balance_cents, 0); assert.equal(inv.payments.length, 2);
  assert.equal((await call('DELETE', '/api/payments/' + inv.payments[1].id, { cookie: st })).status, 200);
  assert.equal((await call('GET', '/api/invoices/' + i1, { cookie: st })).data.balance_cents, 30000);

  // void keeps the number; numbers are never reused
  assert.equal((await call('POST', `/api/invoices/${i2}/void`, { cookie: st })).status, 200);
  const i3 = (await call('POST', '/api/invoices', { cookie: st, json: draft(b) })).data.id;
  assert.equal((await call('POST', `/api/invoices/${i3}/send`, { cookie: st })).data.number, 'INV-0003');
  assert.equal((await call('GET', '/api/invoices/' + i2, { cookie: st })).data.state, 'void');

  // overdue + summary
  const old = (await call('POST', '/api/invoices', { cookie: st, json: draft(b, { issueDate: '2020-01-01', dueDate: '2020-01-31' }) })).data.id;
  await call('POST', `/api/invoices/${old}/send`, { cookie: st });
  assert.equal((await call('GET', '/api/invoices/' + old, { cookie: st })).data.overdue, true);
  const sum = (await call('GET', '/api/billing/summary', { cookie: st })).data;
  assert.equal(sum.outstanding_cents, 30000 + 53333 + 53333);
  assert.equal(sum.overdue_cents, 53333);

  // clients with invoice history cannot be deleted
  assert.equal((await call('DELETE', '/api/clients/' + a, { cookie: st })).status, 409);
});

test('monthly fees generate one draft per client per month', async () => {
  const st = await login('staff@ra.test', 'staff-password-1');
  const c = (await call('POST', '/api/clients', { cookie: st, json: { name: 'Gamma', email: 'g@gamma.test', password: 'gamma-password-1' } })).data.id;
  assert.equal((await call('POST', `/api/clients/${c}/fee`, { cookie: st, json: { feeCents: -5 } })).status, 400);
  assert.equal((await call('POST', `/api/clients/${c}/fee`, { cookie: st, json: { feeCents: 35000, description: 'Bookkeeping & payroll' } })).status, 200);
  assert.equal((await call('POST', '/api/billing/generate', { cookie: st, json: { period: '2026-13' } })).status, 400);
  assert.deepEqual((await call('POST', '/api/billing/generate', { cookie: st, json: { period: '2026-12' } })).data, { created: 1, skipped: 0 });
  assert.deepEqual((await call('POST', '/api/billing/generate', { cookie: st, json: { period: '2026-12' } })).data, { created: 0, skipped: 1 });
  const list = (await call('GET', '/api/invoices?clientId=' + c, { cookie: st })).data;
  assert.equal(list.length, 1); assert.equal(list[0].state, 'draft'); assert.equal(list[0].total_cents, 35000);
  const full = (await call('GET', '/api/invoices/' + list[0].id, { cookie: st })).data;
  assert.equal(full.lines[0].description, 'Bookkeeping & payroll — December 2026');
  // a draft-only client can still be deleted
  assert.equal((await call('DELETE', '/api/clients/' + c, { cookie: st })).status, 200);
});
