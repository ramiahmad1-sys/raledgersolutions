/* Printable invoice. Same login cookie as the portal; the server decides who may see which invoice. */
'use strict';
const FIRM = {
  name: 'RA Ledger Solutions', legal: 'Alquds Accounting Services LLC',
  lines: ['Staten Island, NY 10309', '(718) 285-6959', 'certifiedacct10@gmail.com', 'raledgersolutions.com']
};
const doc = document.getElementById('doc');
document.getElementById('print').addEventListener('click', () => window.print());
const money = c => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const date = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const r = await fetch('/api/invoices/' + encodeURIComponent(id || ''), { credentials: 'same-origin' });
  if (r.status === 401) { doc.replaceChildren(h('p', {}, 'Please ', h('a', { href: '/portal/' }, 'sign in to the portal'), ' first, then open the invoice again.')); return; }
  if (!r.ok) { doc.replaceChildren(h('p', {}, 'Invoice not found.')); return; }
  const inv = await r.json();
  const stamp = inv.state === 'paid' ? 'PAID' : inv.state === 'void' ? 'VOID' : inv.state === 'draft' ? 'DRAFT' : null;
  document.title = (inv.number || 'Draft invoice') + ' | RA Ledger Solutions';
  doc.replaceChildren(...[
    stamp ? h('div', { class: 'stamp ' + inv.state }, stamp) : null,
    h('div', { class: 'head' },
      h('div', { class: 'firm' }, h('div', { class: 'name' }, FIRM.name), h('div', {}, FIRM.legal), FIRM.lines.map(l => h('div', {}, l))),
      h('div', { class: 'meta' }, h('h1', {}, 'INVOICE'), h('div', {}, h('strong', {}, inv.number || 'Draft')),
        h('div', {}, 'Issued ' + date(inv.issue_date)), h('div', {}, 'Due ' + date(inv.due_date)))),
    h('div', { class: 'billto' }, h('div', { class: 'label' }, 'Bill to'), h('div', {}, h('strong', {}, inv.client_name)), inv.client_contact ? h('div', {}, inv.client_contact) : null),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Rate'), h('th', { class: 'num' }, 'Amount'))),
      h('tbody', {}, inv.lines.map(l => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, String(l.qty)), h('td', { class: 'num' }, money(l.unit_cents)), h('td', { class: 'num' }, money(l.amount_cents))))),
      h('tfoot', {},
        h('tr', {}, h('td', { colspan: 3, class: 'num' }, 'Total'), h('td', { class: 'num' }, money(inv.total_cents))),
        inv.paid_cents ? h('tr', {}, h('td', { colspan: 3, class: 'num' }, 'Payments received'), h('td', { class: 'num' }, '−' + money(inv.paid_cents))) : null,
        inv.status === 'sent' ? h('tr', { class: 'due' }, h('td', { colspan: 3, class: 'num' }, 'Balance due'), h('td', { class: 'num' }, money(inv.balance_cents))) : null)),
    inv.notes ? h('div', { class: 'notes' }, inv.notes) : null,
    inv.pay_link && inv.balance_cents > 0 ? h('div', { class: 'pay' }, 'Pay online: ', h('a', { href: inv.pay_link, rel: 'noopener noreferrer' }, inv.pay_link)) : null,
    h('div', { class: 'foot' }, 'Thank you for your business.')].filter(Boolean));
})().catch(() => doc.replaceChildren(h('p', {}, 'Could not load the invoice.')));
