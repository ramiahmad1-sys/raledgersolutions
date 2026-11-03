/* Billing screens: invoices, payments, monthly fees. Uses h/api/act/toast/tabs/fmtDate from portal.js. */
'use strict';

const money = c => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
function parseMoney(s) {
  s = String(s).replace(/[$,\s]/g, '');
  return /^-?\d+(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) : NaN;
}
const todayLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const plusDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const STATE_LABEL = { draft: 'Draft', open: 'Open', partial: 'Partly paid', paid: 'Paid', void: 'Void' };
const METHOD_LABEL = { check: 'Check', ach: 'ACH / bank transfer', card: 'Card', cash: 'Cash', zelle: 'Zelle', other: 'Other' };
function invPill(i) {
  const cls = i.overdue ? 'late' : i.state === 'paid' ? 'done' : i.state === 'draft' || i.state === 'void' ? 'grey' : 'open';
  return h('span', { class: 'pill ' + cls }, i.overdue ? 'Overdue' : STATE_LABEL[i.state]);
}
const printLink = id => h('a', { class: 'btn sm sec', href: '/portal/invoice.html?id=' + encodeURIComponent(id), target: '_blank', rel: 'noopener' }, 'Print / PDF');

function invoicesTable(list, { showClient, onOpen }) {
  if (!list.length) return h('p', { class: 'empty' }, 'No invoices.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Invoice', showClient ? 'Client' : null, 'Issued', 'Due', 'Total', 'Balance', 'Status', ''].filter(x => x !== null).map(t => h('th', {}, t)))),
    h('tbody', {}, list.map(i => h('tr', {},
      h('td', {}, i.number || h('span', { class: 'muted' }, 'Draft')), showClient ? h('td', {}, i.client_name) : null,
      h('td', {}, fmtDate(i.issue_date)), h('td', {}, fmtDate(i.due_date)), h('td', { class: 'num' }, money(i.total_cents)),
      h('td', { class: 'num' }, i.status === 'sent' ? money(i.balance_cents) : '—'), h('td', {}, invPill(i)),
      h('td', {}, h('button', { class: 'btn sm sec', onclick: () => onOpen(i.id) }, 'View'))))));
}

/* ---------- invoice detail (staff and client) ---------- */
async function invoiceView(id, { staff, back }) {
  const inv = await api('GET', '/api/invoices/' + encodeURIComponent(id));
  const again = () => invoiceView(id, { staff, back });
  const lines = h('table', {}, h('thead', {}, h('tr', {}, ['Description', 'Qty', 'Rate', 'Amount'].map((t, i) => h('th', { class: i ? 'num' : null }, t)))),
    h('tbody', {}, inv.lines.map(l => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, String(l.qty)), h('td', { class: 'num' }, money(l.unit_cents)), h('td', { class: 'num' }, money(l.amount_cents))))),
    h('tfoot', {},
      h('tr', {}, h('td', { colspan: 3, class: 'num' }, 'Total'), h('td', { class: 'num' }, h('strong', {}, money(inv.total_cents)))),
      inv.status === 'sent' ? [
        h('tr', {}, h('td', { colspan: 3, class: 'num' }, 'Paid'), h('td', { class: 'num' }, money(inv.paid_cents))),
        h('tr', {}, h('td', { colspan: 3, class: 'num' }, h('strong', {}, 'Balance due')), h('td', { class: 'num' }, h('strong', {}, money(inv.balance_cents))))] : null));

  const pays = inv.payments.length ? h('div', { class: 'card' }, h('h2', {}, 'Payments received'),
    h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Method', 'Reference', 'Amount', staff ? '' : null].filter(x => x !== null).map(t => h('th', {}, t)))),
      h('tbody', {}, inv.payments.map(p => h('tr', {}, h('td', {}, fmtDate(p.date)), h('td', {}, METHOD_LABEL[p.method] || p.method), h('td', {}, p.reference || '—'),
        h('td', { class: 'num' }, money(p.amount_cents)),
        staff ? h('td', {}, h('button', { class: 'btn sm danger', onclick: act(async () => {
          if (!confirm('Remove this ' + money(p.amount_cents) + ' payment? Use this only to correct a mistake.')) return;
          await api('DELETE', '/api/payments/' + p.id); toast('Payment removed.'); again();
        }) }, 'Remove')) : null))))) : null;

  const actions = [printLink(inv.id)];
  if (!staff && inv.pay_link && inv.balance_cents > 0) actions.push(h('a', { class: 'btn sm', href: inv.pay_link, target: '_blank', rel: 'noopener noreferrer' }, 'Pay online'));
  if (staff && inv.status === 'draft') actions.push(
    h('button', { class: 'btn sm sec', onclick: () => invoiceEditor({ clientId: inv.client_id, inv, done: newId => invoiceView(newId, { staff, back }), cancel: again }) }, 'Edit'),
    h('button', { class: 'btn sm', onclick: act(async () => {
      if (!confirm('Send ' + money(inv.total_cents) + ' invoice to ' + inv.client_name + '? It gets an invoice number and can no longer be edited.')) return;
      const r = await api('POST', `/api/invoices/${inv.id}/send`); toast(r.number + ' sent to ' + inv.client_name + '.'); again();
    }) }, 'Send to client'),
    h('button', { class: 'btn sm danger', onclick: act(async () => { if (!confirm('Delete this draft?')) return; await api('DELETE', '/api/invoices/' + inv.id); toast('Draft deleted.'); back(); }) }, 'Delete draft'));
  if (staff && inv.status === 'sent' && inv.paid_cents === 0) actions.push(h('button', { class: 'btn sm danger', onclick: act(async () => {
    if (!confirm('Void ' + inv.number + '? The number stays on record and the client will see it as void.')) return;
    await api('POST', `/api/invoices/${inv.id}/void`); toast(inv.number + ' voided.'); again();
  }) }, 'Void'));

  let payForm = null;
  if (staff && inv.status === 'sent' && inv.balance_cents > 0) {
    const date = h('input', { type: 'date', required: true, value: todayLocal() });
    const amt = h('input', { required: true, inputmode: 'decimal', value: (inv.balance_cents / 100).toFixed(2) });
    const method = h('select', {}, Object.entries(METHOD_LABEL).map(([v, l]) => h('option', { value: v }, l)));
    const ref = h('input', { maxlength: 100, placeholder: 'Check #, confirmation #' });
    payForm = h('div', { class: 'card' }, h('h2', {}, 'Record a payment'), h('form', { class: 'stack', onsubmit: act(async e => {
      e.preventDefault();
      const cents = parseMoney(amt.value); if (!(cents > 0)) return toast('Enter a valid amount.');
      await api('POST', `/api/invoices/${inv.id}/payments`, { date: date.value, amountCents: cents, method: method.value, reference: ref.value });
      toast('Payment of ' + money(cents) + ' recorded.'); again();
    }) }, h('div', { class: 'row' }, h('label', {}, 'Date received', date), h('label', {}, 'Amount', amt), h('label', {}, 'Method', method), h('label', {}, 'Reference', ref)),
      h('div', {}, h('button', { class: 'btn' }, 'Record payment'))));
  }

  render(h('p', {}, h('button', { class: 'btn sm sec', onclick: back }, '← Back')),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('h1', {}, inv.number ? 'Invoice ' + inv.number : 'Draft invoice'), staff ? h('div', { class: 'muted' }, inv.client_name) : null),
        h('div', { class: 'fit' }, invPill(inv))),
      h('p', { class: 'muted' }, 'Issued ' + fmtDate(inv.issue_date) + ' · Due ' + fmtDate(inv.due_date)),
      lines, inv.notes ? h('p', { class: 'notes' }, inv.notes) : null,
      h('div', { class: 'actions' }, actions)),
    payForm, pays);
}

/* ---------- invoice editor (staff, drafts only) ---------- */
function invoiceEditor({ clientId, inv, done, cancel }) {
  const issue = h('input', { type: 'date', required: true, value: inv?.issue_date || todayLocal() });
  const due = h('input', { type: 'date', required: true, value: inv?.due_date || plusDays(todayLocal(), 15) });
  const link = h('input', { type: 'url', maxlength: 500, placeholder: 'https://… (optional, e.g. a QuickBooks payment link)', value: inv?.pay_link || '' });
  const notes = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Optional note shown on the invoice (e.g. payment instructions)' }); notes.value = inv?.notes || '';
  const body = h('tbody', {}), total = h('strong', {});
  const rows = [];
  const recalc = () => {
    let sum = 0;
    for (const r of rows) { const q = Number(r.qty.value), c = parseMoney(r.rate.value); const a = Number.isFinite(q) && !isNaN(c) ? Math.round(q * c) : 0; r.amt.textContent = money(a); sum += a; }
    total.textContent = money(sum);
  };
  const addRow = (l = { description: '', qty: 1, unit_cents: '' }) => {
    const r = {
      desc: h('input', { required: true, maxlength: 300, value: l.description, 'aria-label': 'Description', oninput: recalc }),
      qty: h('input', { required: true, inputmode: 'decimal', value: String(l.qty), 'aria-label': 'Quantity', class: 'qty', oninput: recalc }),
      rate: h('input', { required: true, inputmode: 'decimal', value: l.unit_cents === '' ? '' : (l.unit_cents / 100).toFixed(2), 'aria-label': 'Rate', class: 'rate', oninput: recalc }),
      amt: h('span', {})
    };
    r.tr = h('tr', {}, h('td', {}, r.desc), h('td', {}, r.qty), h('td', {}, r.rate), h('td', { class: 'num' }, r.amt),
      h('td', {}, h('button', { type: 'button', class: 'btn sm danger', 'aria-label': 'Remove line', onclick: () => { if (rows.length > 1) { rows.splice(rows.indexOf(r), 1); r.tr.remove(); recalc(); } } }, '×')));
    rows.push(r); body.append(r.tr); recalc();
  };
  (inv?.lines?.length ? inv.lines : [undefined]).forEach(l => addRow(l));
  const form = h('form', { class: 'stack', onsubmit: act(async e => {
    e.preventDefault();
    const lines = rows.map(r => ({ description: r.desc.value, qty: Number(r.qty.value), unitCents: parseMoney(r.rate.value) }));
    if (lines.some(l => isNaN(l.unitCents))) return toast('Enter each rate as an amount, e.g. 450 or 450.00');
    const payload = { clientId, issueDate: issue.value, dueDate: due.value, payLink: link.value, notes: notes.value, lines };
    if (inv) { await api('PUT', '/api/invoices/' + inv.id, payload); toast('Draft saved.'); done(inv.id); }
    else { const r = await api('POST', '/api/invoices', payload); toast('Draft saved. Review it, then click Send to client.'); done(r.id); }
  }) },
    h('div', { class: 'row' }, h('label', {}, 'Issue date', issue), h('label', {}, 'Due date', due)),
    h('table', { class: 'lines' }, h('thead', {}, h('tr', {}, ['Description', 'Qty / hours', 'Rate ($)', 'Amount', ''].map(t => h('th', {}, t)))), body,
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 3, class: 'num' }, 'Total'), h('td', { class: 'num' }, total), h('td', {})))),
    h('div', {}, h('button', { type: 'button', class: 'btn sm sec', onclick: () => addRow() }, '+ Add line')),
    h('label', {}, 'Online payment link', link), h('label', {}, 'Notes', notes),
    h('div', {}, h('button', { class: 'btn' }, 'Save draft'), ' ', h('button', { type: 'button', class: 'btn sec', onclick: cancel }, 'Cancel')));
  render(h('div', { class: 'card' }, h('h1', {}, inv ? 'Edit draft invoice' : 'New invoice'), form));
}

/* ---------- client: Invoices tab ---------- */
async function clientInvoices(back) {
  const list = await api('GET', '/api/invoices');
  const due = list.filter(i => i.status === 'sent').reduce((s, i) => s + i.balance_cents, 0);
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'stat' }, money(due)), 'total balance due'),
    h('div', { class: 'card' }, h('h2', {}, 'Invoices'), invoicesTable(list, { onOpen: id => invoiceView(id, { staff: false, back }) })));
}

/* ---------- staff: client Billing tab ---------- */
async function staffClientBilling(client, here) {
  const list = await api('GET', '/api/invoices?clientId=' + encodeURIComponent(client.id));
  const fee = h('input', { inputmode: 'decimal', value: ((client.fee_cents || 0) / 100).toFixed(2), 'aria-label': 'Monthly fee' });
  const desc = h('input', { maxlength: 200, value: client.fee_desc || '', placeholder: 'Monthly bookkeeping services' });
  const back = () => here('Billing');
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', {}, 'Invoices'),
      h('div', { class: 'fit' }, h('button', { class: 'btn sm', onclick: () => invoiceEditor({ clientId: client.id, done: id => invoiceView(id, { staff: true, back }), cancel: back }) }, '+ New invoice'))),
      invoicesTable(list, { onOpen: id => invoiceView(id, { staff: true, back }) })),
    h('div', { class: 'card' }, h('h2', {}, 'Monthly fee'),
      h('p', { class: 'muted' }, 'Clients with a monthly fee get a draft invoice when you click "Create monthly invoices" on the Billing page. Set to 0 to turn off.'),
      h('form', { class: 'stack', onsubmit: act(async e => {
        e.preventDefault();
        const cents = parseMoney(fee.value); if (isNaN(cents) || cents < 0) return toast('Enter a valid fee, e.g. 450.00');
        await api('POST', `/api/clients/${client.id}/fee`, { feeCents: cents, description: desc.value }); toast('Monthly fee saved.'); here('Billing');
      }) }, h('div', { class: 'row' }, h('label', {}, 'Amount ($)', fee), h('label', {}, 'Invoice description', desc)), h('div', {}, h('button', { class: 'btn' }, 'Save fee')))));
}

/* ---------- staff: Billing page ---------- */
async function staffBilling(re, filter = 'open') {
  const [sum, all] = await Promise.all([api('GET', '/api/billing/summary'), api('GET', '/api/invoices')]);
  const back = () => staffBilling(re, filter);
  const shown = filter === 'open' ? all.filter(i => i.state === 'open' || i.state === 'partial') : filter === 'draft' ? all.filter(i => i.state === 'draft') : all;
  const month = h('input', { type: 'month', required: true, value: todayLocal().slice(0, 7) });
  const sel = h('select', { 'aria-label': 'Show', onchange: () => staffBilling(re, sel.value) },
    [['open', 'Unpaid'], ['draft', 'Drafts'], ['all', 'All invoices']].map(([v, l]) => h('option', { value: v, selected: v === filter }, l)));
  render(sectionNav('billing', re), h('h1', {}, 'Billing'),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'stat' }, money(sum.outstanding_cents)), 'outstanding'),
      h('div', { class: 'card' }, h('div', { class: 'stat' + (sum.overdue_cents ? ' warn' : '') }, money(sum.overdue_cents)), 'overdue'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, money(sum.paid_this_month_cents)), 'received this month'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, sum.drafts), 'drafts to review')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', {}, 'Invoices'), h('div', { class: 'fit' }, sel)),
      invoicesTable(shown, { showClient: true, onOpen: id => invoiceView(id, { staff: true, back }) })),
    h('div', { class: 'card' }, h('h2', {}, 'Create monthly invoices'),
      sum.monthly_fees.length ? [
        h('p', { class: 'muted' }, 'Creates a draft for each client below (skips anyone who already has one for that month). Nothing is sent until you review each draft and click Send.'),
        h('ul', {}, sum.monthly_fees.map(c => h('li', {}, c.name + ' — ' + money(c.fee_cents) + (c.fee_desc ? ' (' + c.fee_desc + ')' : '')))),
        h('form', { class: 'row', onsubmit: act(async e => {
          e.preventDefault();
          const r = await api('POST', '/api/billing/generate', { period: month.value });
          toast(r.created + ' draft' + (r.created === 1 ? '' : 's') + ' created' + (r.skipped ? ', ' + r.skipped + ' already existed' : '') + '.'); staffBilling(re, 'draft');
        }) }, h('label', {}, 'Month', month), h('div', { class: 'fit' }, h('button', { class: 'btn' }, 'Create drafts')))]
        : h('p', { class: 'empty' }, 'No monthly fees set. Open a client, go to the Billing tab and set their monthly fee.')));
}
