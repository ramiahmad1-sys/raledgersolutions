/* RA Ledger Solutions client portal front end. Talks to the server API in server/server.js. */
'use strict';

const $app = document.getElementById('app');
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function h(tag, attrs, ...kids) {           // safe element builder: never uses innerHTML
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------- API ---------- */
async function api(method, path, body, raw) {
  const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'ra-portal' } };
  if (raw) { opts.body = raw; if (raw.type) opts.headers['Content-Type'] = raw.type; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login' && path !== '/api/me') { state.me = null; route(); throw new Error('Please sign in again.'); }
  if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
  return data;
}
/* run an action; show server errors as a toast instead of crashing */
const act = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

const state = { me: null };

function renderUserbar() {
  const bar = document.getElementById('userbar'); bar.replaceChildren();
  if (!state.me) return;
  bar.append(h('span', {}, state.me.role === 'staff' ? 'Staff · ' + state.me.email : state.me.name),
    h('button', { class: 'linkbtn', onclick: () => accountView() }, 'Account'),
    h('button', { class: 'linkbtn', onclick: act(async () => { await api('POST', '/api/logout'); state.me = null; route(); }) }, 'Sign out'));
}

async function route() {
  if (!state.me) { try { state.me = await api('GET', '/api/me'); } catch { state.me = null; } }
  renderUserbar();
  $app.replaceChildren();
  if (!state.me) return loginView();
  return state.me.role === 'staff' ? staffView() : clientView();
}

/* ---------- login & account ---------- */
function loginView() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', { class: 'stack', onsubmit: act(async e => {
    e.preventDefault();
    state.me = await api('POST', '/api/login', { email: email.value, password: pw.value }); route();
  }) }, h('label', {}, 'Email', email), h('label', {}, 'Password', pw), h('button', { class: 'btn' }, 'Sign in'));
  $app.append(h('div', { class: 'login' },
    h('div', { class: 'card' }, h('h1', {}, 'Sign in'), h('p', { class: 'muted' }, 'Clients: upload documents, download your monthly reports, and message your accountant. Need access? Ask your accountant to set up your account.'), form)));
}
function accountView() {
  const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const np = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  $app.replaceChildren(h('p', {}, h('button', { class: 'btn sm sec', onclick: route }, '← Back')),
    h('div', { class: 'card' }, h('h1', {}, 'Change password'), h('form', { class: 'stack', onsubmit: act(async e => {
      e.preventDefault(); await api('POST', '/api/password', { current: cur.value, password: np.value }); toast('Password changed.'); route();
    }) }, h('label', {}, 'Current password', cur), h('label', {}, 'New password (10+ characters)', np), h('div', {}, h('button', { class: 'btn' }, 'Update password')))));
}

/* ---------- shared widgets ---------- */
function tabs(names, active, onpick) {
  return h('div', { class: 'tabs', role: 'tablist' }, names.map(n =>
    h('button', { role: 'tab', 'aria-selected': String(n === active), onclick: () => onpick(n) }, n)));
}
const MAX = 15 * 1024 * 1024;
async function uploadFiles(list, params) {
  for (const f of list) {
    if (f.size > MAX) { toast(f.name + ' is over 15 MB and was skipped.'); continue; }
    const q = new URLSearchParams({ ...params, name: f.name });
    await api('POST', '/api/files?' + q, undefined, f);
  }
}
function filesTable(files, { canDelete, onChange }) {
  if (!files.length) return h('p', { class: 'empty' }, 'Nothing here yet.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['File', 'Period', 'Added', 'Size', ''].map(t => h('th', {}, t)))),
    h('tbody', {}, files.map(f => h('tr', {},
      h('td', {}, f.name, f.note ? h('div', { class: 'muted' }, f.note) : null),
      h('td', {}, f.period || '—'), h('td', {}, fmtDate(f.date)), h('td', {}, fmtSize(f.size)),
      h('td', {}, h('a', { class: 'btn sm sec', href: '/api/files/' + f.id }, 'Download'), ' ',
        canDelete ? h('button', { class: 'btn sm danger', onclick: act(async () => { if (confirm('Delete ' + f.name + '?')) { await api('DELETE', '/api/files/' + f.id); onChange(); } }) }, 'Delete') : null)))));
}
function requestsTable(reqs, { onChange, staff }) {
  if (!reqs.length) return h('p', { class: 'empty' }, 'No requests.');
  const sorted = [...reqs].sort((a, b) => a.status === b.status ? (a.due || '9').localeCompare(b.due || '9') : a.status === 'open' ? -1 : 1);
  return h('table', {}, h('thead', {}, h('tr', {}, ['Request', 'Due', 'Status', ''].map(t => h('th', {}, t)))),
    h('tbody', {}, sorted.map(r => {
      const late = r.status === 'open' && r.due && r.due < today();
      return h('tr', {}, h('td', {}, r.title), h('td', {}, fmtDate(r.due) || '—'),
        h('td', {}, h('span', { class: 'pill ' + (late ? 'late' : r.status) }, late ? 'Overdue' : r.status === 'open' ? 'Open' : 'Done')),
        h('td', {}, h('button', { class: 'btn sm sec', onclick: act(async () => { await api('PATCH', '/api/requests/' + r.id, { status: r.status === 'open' ? 'done' : 'open' }); onChange(); }) }, r.status === 'open' ? 'Mark done' : 'Reopen'), ' ',
          staff ? h('button', { class: 'btn sm danger', onclick: act(async () => { await api('DELETE', '/api/requests/' + r.id); onChange(); }) }, 'Remove') : null));
    })));
}
function messagesPanel(data, me, rerender) {
  const box = h('div', { class: 'msgs' }, data.messages.length ? data.messages.map(m => h('div', { class: 'msg' + (m.sender === me ? ' me' : '') },
    m.text, h('time', {}, (m.sender === 'staff' ? 'RA Ledger' : data.client.name) + ' · ' + new Date(m.date).toLocaleString()))) : h('p', { class: 'empty' }, 'No messages yet.'));
  const ta = h('textarea', { rows: 3, required: true, maxlength: 4000, 'aria-label': 'Message' });
  const form = h('form', { class: 'stack', onsubmit: act(async e => {
    e.preventDefault(); await api('POST', '/api/messages', { clientId: data.client.id, text: ta.value }); rerender();
  }) }, ta, h('div', {}, h('button', { class: 'btn' }, 'Send')));
  setTimeout(() => { box.scrollTop = box.scrollHeight; });
  return h('div', {}, box, form);
}
function uploadForm({ withPeriod, label, onSubmit }) {
  const file = h('input', { type: 'file', multiple: true, required: true });
  const period = withPeriod ? h('input', { type: 'month', value: today().slice(0, 7) }) : null;
  const note = h('input', { type: 'text', maxlength: 140, placeholder: 'Optional note' });
  const btn = h('button', { class: 'btn' }, 'Upload');
  return h('form', { class: 'stack', onsubmit: act(async e => {
    e.preventDefault(); btn.disabled = true; btn.textContent = 'Uploading…';
    try { await onSubmit([...file.files], period?.value || '', note.value.trim()); } finally { btn.disabled = false; btn.textContent = 'Upload'; }
  }) }, h('label', {}, label, file), h('div', { class: 'row' }, withPeriod ? h('label', {}, 'Period', period) : null, h('label', {}, 'Note', note)), h('div', {}, btn));
}

/* ---------- client view ---------- */
async function clientView(tab = 'Overview') {
  const data = await api('GET', '/api/data');
  const { client, files, requests: reqs } = data;
  const reports = files.filter(f => f.kind === 'report'), docs = files.filter(f => f.kind === 'doc');
  const open = reqs.filter(r => r.status === 'open');
  const again = t => clientView(t || tab);
  let body;
  if (tab === 'Overview') {
    body = h('div', {}, h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'stat' }, open.length), 'open requests from your accountant'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, reports.length), 'reports available'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, docs.length), 'documents you’ve sent')),
      h('div', { class: 'card' }, h('h2', {}, 'Needs your attention'), open.length ? requestsTable(open, { onChange: again }) : h('p', { class: 'empty' }, 'You’re all caught up.')));
  } else if (tab === 'Reports') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Monthly reports'), filesTable(reports, { onChange: again }));
  } else if (tab === 'Documents') {
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'Send documents'), h('p', { class: 'muted' }, 'Bank and card statements, receipts, invoices, payroll records. Up to 15 MB per file.'),
      uploadForm({ withPeriod: true, label: 'Choose files', onSubmit: async (fl, p, n) => { await uploadFiles(fl, { period: p, note: n }); toast('Uploaded.'); again(); } })),
      h('div', { class: 'card' }, h('h2', {}, 'Your uploads'), filesTable(docs, { canDelete: true, onChange: again })));
  } else if (tab === 'Requests') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Requests'), requestsTable(reqs, { onChange: again }));
  } else {
    body = h('div', { class: 'card' }, h('h2', {}, 'Messages'), messagesPanel(data, 'client', () => again('Messages')));
  }
  $app.replaceChildren(h('h1', {}, 'Welcome, ' + client.name), tabs(['Overview', 'Reports', 'Documents', 'Requests', 'Messages'], tab, again), body);
}

/* ---------- staff view ---------- */
async function staffView(view = {}) {
  const re = v => staffView(v ?? view);
  if (view.clientId) return staffClient(view.clientId, view.tab || 'Reports', re);
  if (view.page === 'staff') return staffAccounts(re);
  const clients = await api('GET', '/api/clients');
  const rows = clients.map(c => h('tr', {}, h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, c.email || '')),
    h('td', {}, c.docs + ' docs'),
    h('td', {}, c.open_requests ? h('span', { class: 'pill open' }, c.open_requests + ' open') : h('span', { class: 'pill done' }, 'none')),
    h('td', {}, c.last_message ? (c.last_message.startsWith('client') ? 'Client' : 'You') + c.last_message.slice(c.last_message.indexOf(':')) : '—'),
    h('td', {}, h('button', { class: 'btn sm', onclick: () => re({ clientId: c.id }) }, 'Open'))));
  const name = h('input', { required: true, maxlength: 150 }), contact = h('input', { maxlength: 150, placeholder: 'Contact person' });
  const email = h('input', { type: 'email', required: true }), pw = h('input', { required: true, minlength: 10, placeholder: 'Temporary, 10+ characters', autocomplete: 'off' });
  const addForm = h('form', { class: 'stack', onsubmit: act(async e => {
    e.preventDefault();
    await api('POST', '/api/clients', { name: name.value, contact: contact.value, email: email.value, password: pw.value });
    toast('Client added. Send them the login details securely and ask them to change the password.'); re({});
  }) }, h('div', { class: 'row' }, h('label', {}, 'Company name', name), h('label', {}, 'Contact', contact)),
    h('div', { class: 'row' }, h('label', {}, 'Client login email', email), h('label', {}, 'Temporary password', pw)), h('div', {}, h('button', { class: 'btn' }, 'Add client')));
  $app.replaceChildren(sectionNav('clients', re), h('h1', {}, 'Clients'),
    h('div', { class: 'card' }, clients.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Client', 'Uploads', 'Requests', 'Last message', ''].map(t => h('th', {}, t)))), h('tbody', {}, rows)) : h('p', { class: 'empty' }, 'No clients yet. Add your first one below.')),
    h('div', { class: 'card' }, h('h2', {}, 'Add a client'), addForm));
}

function sectionNav(active, re) {
  return tabs(['Clients', 'Staff accounts'], active === 'staff' ? 'Staff accounts' : 'Clients', n => re(n === 'Clients' ? {} : { page: 'staff' }));
}
async function staffAccounts(re) {
  const list = await api('GET', '/api/staff');
  const here = () => re({ page: 'staff' });
  const rows = list.map(u => {
    const np = () => { const v = prompt('New temporary password for ' + u.email + ' (10+ characters):'); return v; };
    return h('tr', {}, h('td', {}, u.email, u.you ? h('span', { class: 'pill done' }, 'You') : null), h('td', {}, fmtDate(u.created)),
      h('td', {}, u.you ? h('span', { class: 'muted' }, 'Use Account to change your password') : [
        h('button', { class: 'btn sm sec', onclick: act(async () => { const v = np(); if (!v) return; await api('POST', `/api/staff/${u.id}/password`, { password: v }); toast('Password reset. They have been signed out.'); }) }, 'Reset password'), ' ',
        h('button', { class: 'btn sm danger', onclick: act(async () => { if (!confirm('Remove ' + u.email + '? They will be signed out immediately.')) return; await api('DELETE', '/api/staff/' + u.id); toast('Removed.'); here(); }) }, 'Remove')]));
  });
  const email = h('input', { type: 'email', required: true }), pw = h('input', { required: true, minlength: 10, autocomplete: 'off', placeholder: 'Temporary, 10+ characters' });
  $app.replaceChildren(sectionNav('staff', re), h('h1', {}, 'Staff accounts'),
    h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Email', 'Added', ''].map(t => h('th', {}, t)))), h('tbody', {}, rows)),
      h('p', { class: 'muted' }, 'Staff can see every client\u2019s data and manage all accounts. Only add people you trust. If email notifications are on, each staff login also receives them.')),
    h('div', { class: 'card' }, h('h2', {}, 'Add a staff member'), h('form', { class: 'stack', onsubmit: act(async e => {
      e.preventDefault(); await api('POST', '/api/staff', { email: email.value, password: pw.value }); toast('Staff member added. Share the temporary password securely.'); here();
    }) }, h('div', { class: 'row' }, h('label', {}, 'Email', email), h('label', {}, 'Temporary password', pw)), h('div', {}, h('button', { class: 'btn' }, 'Add staff member')))));
}

async function staffClient(clientId, tab, re) {
  const data = await api('GET', '/api/data?clientId=' + encodeURIComponent(clientId));
  const { client: c, files, requests: reqs } = data;
  const here = t => re({ clientId, tab: t || tab });
  let body;
  if (tab === 'Reports') {
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'Publish a report'),
      uploadForm({ withPeriod: true, label: 'Report files (P&L, balance sheet, etc.)', onSubmit: async (fl, p, n) => { await uploadFiles(fl, { clientId, kind: 'report', period: p, note: n }); toast('Published.'); here(); } })),
      h('div', { class: 'card' }, h('h2', {}, 'Published reports'), filesTable(files.filter(f => f.kind === 'report'), { canDelete: true, onChange: here })));
  } else if (tab === 'Client uploads') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Documents from ' + c.name), filesTable(files.filter(f => f.kind === 'doc'), { canDelete: true, onChange: here }));
  } else if (tab === 'Requests') {
    const title = h('input', { required: true, maxlength: 200, placeholder: 'e.g. March bank statement' }), due = h('input', { type: 'date' });
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'New request'), h('form', { class: 'stack', onsubmit: act(async e => {
      e.preventDefault(); await api('POST', '/api/requests', { clientId, title: title.value, due: due.value }); here();
    }) }, h('div', { class: 'row' }, h('label', {}, 'What do you need?', title), h('label', {}, 'Due', due)), h('div', {}, h('button', { class: 'btn' }, 'Send request')))),
      h('div', { class: 'card' }, h('h2', {}, 'All requests'), requestsTable(reqs, { onChange: here, staff: true })));
  } else if (tab === 'Account') {
    const np = h('input', { required: true, minlength: 10, autocomplete: 'off', placeholder: '10+ characters' });
    body = h('div', { class: 'card' }, h('h2', {}, 'Reset client password'), h('form', { class: 'stack', onsubmit: act(async e => {
      e.preventDefault(); await api('POST', `/api/clients/${clientId}/password`, { password: np.value }); np.value = ''; toast('Password reset. Client has been signed out.');
    }) }, h('label', {}, 'New temporary password', np), h('div', {}, h('button', { class: 'btn' }, 'Reset password'))));
  } else {
    body = h('div', { class: 'card' }, h('h2', {}, 'Messages'), messagesPanel(data, 'staff', () => here('Messages')));
  }
  const danger = h('button', { class: 'btn danger sm', onclick: act(async () => {
    if (!confirm('Delete ' + c.name + ' and ALL their files, requests and messages? This cannot be undone.')) return;
    await api('DELETE', '/api/clients/' + clientId); re({});
  }) }, 'Delete client');
  $app.replaceChildren(h('p', {}, h('button', { class: 'btn sm sec', onclick: () => re({}) }, '← All clients')),
    h('div', { class: 'row' }, h('h1', {}, c.name), h('div', { class: 'fit' }, danger)),
    tabs(['Reports', 'Client uploads', 'Requests', 'Messages', 'Account'], tab, here), body);
}

route().catch(e => { $app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Portal unavailable'), h('p', {}, e.message))); });
