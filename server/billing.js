'use strict';
/* Billing: invoices, line items, payments and monthly fees.
   Money is stored as integer cents. Invoice numbers are assigned when an invoice is sent and are never reused:
   sent invoices cannot be edited or deleted, only voided (and only while they have no payments). */
const crypto = require('node:crypto');
const { db } = require('./db');
const { notify } = require('./mail');

db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  number TEXT UNIQUE, period TEXT NOT NULL DEFAULT '', issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','void')),
  notes TEXT NOT NULL DEFAULT '', pay_link TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, sent_at TEXT, voided_at TEXT);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, pos INTEGER NOT NULL,
  description TEXT NOT NULL, qty REAL NOT NULL, unit_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), method TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inv_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_lines_inv ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_pay_inv ON payments(invoice_id);
`);
{
  const cols = db.prepare('PRAGMA table_info(clients)').all().map(c => c.name);
  if (!cols.includes('fee_cents')) db.exec('ALTER TABLE clients ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('fee_desc')) db.exec("ALTER TABLE clients ADD COLUMN fee_desc TEXT NOT NULL DEFAULT ''");
}

const METHODS = ['check', 'ach', 'card', 'cash', 'zelle', 'other'];
const now = () => new Date().toISOString();
const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().startsWith(d);
const isCents = (v, { min = -1e11, max = 1e11 } = {}) => Number.isInteger(v) && v >= min && v <= max;

const BASE = `SELECT i.*, c.name AS client_name, c.contact AS client_contact,
  COALESCE((SELECT SUM(amount_cents) FROM invoice_lines l WHERE l.invoice_id=i.id),0) AS total_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id=i.id),0) AS paid_cents
  FROM invoices i JOIN clients c ON c.id=i.client_id`;
function decorate(inv) {
  const balance = inv.total_cents - inv.paid_cents;
  const state = inv.status === 'void' ? 'void' : inv.status === 'draft' ? 'draft' : balance <= 0 ? 'paid' : inv.paid_cents > 0 ? 'partial' : 'open';
  return { ...inv, balance_cents: inv.status === 'sent' ? balance : 0, state, overdue: (state === 'open' || state === 'partial') && inv.due_date < todayNY() };
}

function parseInvoiceBody(b, { str, bad }) {
  const issue = b.issueDate, due = b.dueDate;
  if (!isDate(issue) || !isDate(due)) throw bad('Enter valid issue and due dates.');
  if (due < issue) throw bad('Due date cannot be before the issue date.');
  const notes = str(b.notes, 2000, { required: false });
  let payLink = str(b.payLink, 500, { required: false });
  if (payLink) { let u; try { u = new URL(payLink); } catch {} if (!u || u.protocol !== 'https:') throw bad('Payment link must start with https://'); payLink = u.href; }
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 50) throw bad('Add between 1 and 50 line items.');
  const lines = b.lines.map(l => {
    const description = str(l && l.description, 300);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000 || Math.round(qty * 100) !== qty * 100) throw bad('Quantity must be a positive number with up to 2 decimals.');
    if (!isCents(l.unitCents, { min: -1e9, max: 1e9 })) throw bad('Enter a valid rate for each line.');
    return { description, qty, unit_cents: l.unitCents, amount_cents: Math.round(qty * l.unitCents) };
  });
  if (lines.reduce((s, l) => s + l.amount_cents, 0) <= 0) throw bad('Invoice total must be more than $0.00.');
  return { issue, due, notes, payLink, lines };
}
function writeLines(invoiceId, lines) {
  db.prepare('DELETE FROM invoice_lines WHERE invoice_id=?').run(invoiceId);
  const ins = db.prepare('INSERT INTO invoice_lines (id,invoice_id,pos,description,qty,unit_cents,amount_cents) VALUES (?,?,?,?,?,?,?)');
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), invoiceId, i, l.description, l.qty, l.unit_cents, l.amount_cents));
}
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

function createDraft(clientId, { issue, due, notes = '', payLink = '', lines, period = '' }) {
  const id = crypto.randomUUID();
  tx(() => {
    db.prepare('INSERT INTO invoices (id,client_id,period,issue_date,due_date,status,notes,pay_link,created) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, clientId, period, issue, due, 'draft', notes, payLink, now());
    writeLines(id, lines);
  });
  return id;
}

/* Route handler. Returns true if it handled the request. */
async function handle({ req, m, p, url, user, readJson, out, str, bad, HttpError, needStaff, scopeClient }) {
  const notFound = () => new HttpError(404, 'Not found');
  const getInvoice = id => {
    const inv = db.prepare(BASE + ' WHERE i.id=?').get(id);
    if (!inv || (user.role === 'client' && (inv.client_id !== user.client_id || inv.status === 'draft'))) throw notFound();
    return decorate(inv);
  };
  let mm;

  if (p === '/api/invoices' && m === 'GET') {
    const all = user.role === 'staff' && !url.searchParams.get('clientId');
    const rows = all ? db.prepare(BASE + ' ORDER BY i.issue_date DESC, i.created DESC').all()
      : db.prepare(BASE + ' WHERE i.client_id=? ORDER BY i.issue_date DESC, i.created DESC').all(scopeClient(user, url.searchParams.get('clientId')));
    return out(rows.map(decorate).filter(i => user.role === 'staff' || i.status !== 'draft')), true;
  }
  if ((mm = p.match(/^\/api\/invoices\/([\w-]+)$/)) && m === 'GET') {
    const inv = getInvoice(mm[1]);
    inv.lines = db.prepare('SELECT description,qty,unit_cents,amount_cents FROM invoice_lines WHERE invoice_id=? ORDER BY pos').all(inv.id);
    inv.payments = db.prepare('SELECT id,date,amount_cents,method,reference FROM payments WHERE invoice_id=? ORDER BY date, created').all(inv.id);
    return out(inv), true;
  }

  /* ----- everything below is staff only ----- */
  if (!p.startsWith('/api/invoices') && !p.startsWith('/api/payments') && !p.startsWith('/api/billing') && !/^\/api\/clients\/[\w-]+\/fee$/.test(p)) return false;
  needStaff(user);

  if (p === '/api/invoices' && m === 'POST') {
    const b = await readJson(req), cid = scopeClient(user, b.clientId);
    return out({ id: createDraft(cid, parseInvoiceBody(b, { str, bad })) }, 201), true;
  }
  if ((mm = p.match(/^\/api\/invoices\/([\w-]+)$/)) && (m === 'PUT' || m === 'DELETE')) {
    const inv = getInvoice(mm[1]);
    if (inv.status !== 'draft') throw bad('Only drafts can be changed. Void a sent invoice instead.');
    if (m === 'DELETE') { db.prepare('DELETE FROM invoices WHERE id=?').run(inv.id); return out({ ok: true }), true; }
    const v = parseInvoiceBody(await readJson(req), { str, bad });
    tx(() => {
      db.prepare('UPDATE invoices SET issue_date=?,due_date=?,notes=?,pay_link=? WHERE id=?').run(v.issue, v.due, v.notes, v.payLink, inv.id);
      writeLines(inv.id, v.lines);
    });
    return out({ ok: true }), true;
  }
  if ((mm = p.match(/^\/api\/invoices\/([\w-]+)\/send$/)) && m === 'POST') {
    const inv = getInvoice(mm[1]);
    if (inv.status !== 'draft') throw bad('This invoice was already sent.');
    if (inv.total_cents <= 0) throw bad('Invoice total must be more than $0.00.');
    const number = tx(() => {
      const n = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number IS NOT NULL").get().n + 1;
      const num = 'INV-' + String(n).padStart(4, '0');
      db.prepare("UPDATE invoices SET status='sent', number=?, sent_at=? WHERE id=? AND status='draft'").run(num, now(), inv.id);
      return num;
    });
    notify('staff', inv.client_id, 'invoice');
    return out({ ok: true, number }), true;
  }
  if ((mm = p.match(/^\/api\/invoices\/([\w-]+)\/void$/)) && m === 'POST') {
    const inv = getInvoice(mm[1]);
    if (inv.status !== 'sent') throw bad('Only sent invoices can be voided.');
    if (inv.paid_cents > 0) throw bad('Remove the recorded payments before voiding this invoice.');
    db.prepare("UPDATE invoices SET status='void', voided_at=? WHERE id=?").run(now(), inv.id);
    return out({ ok: true }), true;
  }
  if ((mm = p.match(/^\/api\/invoices\/([\w-]+)\/payments$/)) && m === 'POST') {
    const inv = getInvoice(mm[1]), b = await readJson(req);
    if (inv.status !== 'sent') throw bad('Payments can only be recorded on sent invoices.');
    if (!isDate(b.date)) throw bad('Enter a valid payment date.');
    if (!isCents(b.amountCents, { min: 1 })) throw bad('Enter a payment amount.');
    if (b.amountCents > inv.balance_cents) throw bad('Payment is more than the balance due.');
    const method = String(b.method || '').toLowerCase(); if (!METHODS.includes(method)) throw bad('Choose a payment method.');
    db.prepare('INSERT INTO payments (id,invoice_id,date,amount_cents,method,reference,created) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), inv.id, b.date, b.amountCents, method, str(b.reference, 100, { required: false }), now());
    return out({ ok: true }, 201), true;
  }
  if ((mm = p.match(/^\/api\/payments\/([\w-]+)$/)) && m === 'DELETE') {
    const r = db.prepare('DELETE FROM payments WHERE id=?').run(mm[1]);
    if (!r.changes) throw notFound();
    return out({ ok: true }), true;
  }
  if ((mm = p.match(/^\/api\/clients\/([\w-]+)\/fee$/)) && m === 'POST') {
    const cid = scopeClient(user, mm[1]), b = await readJson(req);
    if (!isCents(b.feeCents, { min: 0, max: 1e9 })) throw bad('Enter a valid monthly fee.');
    db.prepare('UPDATE clients SET fee_cents=?, fee_desc=? WHERE id=?').run(b.feeCents, str(b.description, 200, { required: false }), cid);
    return out({ ok: true }), true;
  }
  if (p === '/api/billing/summary' && m === 'GET') {
    const inv = db.prepare(BASE + " WHERE i.status='sent'").all().map(decorate);
    const month = todayNY().slice(0, 7);
    return out({
      outstanding_cents: inv.reduce((s, i) => s + i.balance_cents, 0),
      overdue_cents: inv.filter(i => i.overdue).reduce((s, i) => s + i.balance_cents, 0),
      paid_this_month_cents: db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE substr(date,1,7)=?").get(month).s,
      drafts: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status='draft'").get().n,
      monthly_fees: db.prepare('SELECT id,name,fee_cents,fee_desc FROM clients WHERE fee_cents>0 ORDER BY name COLLATE NOCASE').all()
    }), true;
  }
  if (p === '/api/billing/generate' && m === 'POST') {
    const period = (await readJson(req)).period;
    if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('Choose a month.');
    const label = new Date(period + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const issue = todayNY(), due = addDays(issue, 15);
    let created = 0, skipped = 0;
    for (const c of db.prepare('SELECT id,fee_cents,fee_desc FROM clients WHERE fee_cents>0').all()) {
      if (db.prepare("SELECT 1 FROM invoices WHERE client_id=? AND period=? AND status!='void'").get(c.id, period)) { skipped++; continue; }
      createDraft(c.id, { issue, due, period, lines: [{ description: (c.fee_desc || 'Monthly bookkeeping services') + ' — ' + label, qty: 1, unit_cents: c.fee_cents, amount_cents: c.fee_cents }] });
      created++;
    }
    return out({ created, skipped }), true;
  }
  return false;
}
module.exports = { handle, METHODS };
