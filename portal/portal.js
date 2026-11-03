/* RA Ledger Solutions client portal.
   Static app: all data lives in this browser (IndexedDB). See the notice shown on the login page. */
'use strict';

/* ---------- tiny helpers ---------- */
const $app = document.getElementById('app');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
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
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- IndexedDB ---------- */
const STORES = ['meta', 'clients', 'files', 'requests', 'messages'];
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('ra-portal', 1);
    r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s, { keyPath: 'id' }));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const all = s => tx(s, 'readonly', st => st.getAll());
const get = (s, id) => tx(s, 'readonly', st => st.get(id));
const put = (s, o) => tx(s, 'readwrite', st => { st.put(o); });
const del = (s, id) => tx(s, 'readwrite', st => { st.delete(id); });

/* ---------- session ---------- */
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('ra-session')) } catch { return null } },
  set(v) { sessionStorage.setItem('ra-session', JSON.stringify(v)) },
  clear() { sessionStorage.removeItem('ra-session') }
};
function renderUserbar(s) {
  const bar = document.getElementById('userbar'); bar.replaceChildren();
  if (!s) return;
  bar.append(h('span', {}, s.role === 'staff' ? 'Staff' : s.name),
    h('button', { class: 'linkbtn', onclick: () => { session.clear(); route(); } }, 'Sign out'));
}

/* ---------- routing ---------- */
async function route() {
  const s = session.get();
  renderUserbar(s);
  $app.replaceChildren();
  if (!s) return loginView();
  if (s.role === 'staff') return staffView();
  const c = await get('clients', s.clientId);
  if (!c) { session.clear(); return route(); }
  return clientView(c);
}

/* ---------- login ---------- */
async function loginView() {
  const staffHash = (await get('meta', 'staff'))?.hash;
  const clients = await all('clients');
  const clientSel = h('select', { id: 'cl', required: true }, h('option', { value: '' }, 'Select your company'),
    clients.map(c => h('option', { value: c.id }, c.name)));
  const clientForm = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const c = clients.find(x => x.id === clientSel.value);
    if (!c || await sha(c.id + code.value.trim()) !== c.hash) return toast('Company or access code is incorrect.');
    session.set({ role: 'client', clientId: c.id, name: c.name }); route();
  } });
  const code = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  clientForm.append(h('label', {}, 'Company', clientSel), h('label', {}, 'Access code', code), h('button', { class: 'btn' }, 'Sign in'));

  const pw = h('input', { type: 'password', required: true, minlength: staffHash ? 1 : 8, autocomplete: staffHash ? 'current-password' : 'new-password' });
  const staffForm = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const hash = await sha('staff:' + pw.value);
    if (!staffHash) await put('meta', { id: 'staff', hash });
    else if (hash !== staffHash) return toast('Incorrect passcode.');
    session.set({ role: 'staff' }); route();
  } }, h('label', {}, staffHash ? 'Staff passcode' : 'Create a staff passcode (8+ characters)', pw),
    h('button', { class: 'btn sec' }, staffHash ? 'Staff sign in' : 'Create passcode & sign in'));

  $app.append(h('div', { class: 'login' },
    h('div', { class: 'card' }, h('h1', {}, 'Client sign in'), h('p', { class: 'muted' }, 'Upload documents, download your monthly reports, and message your accountant.'), clientForm),
    h('div', { class: 'card' }, h('h2', {}, 'RA Ledger Solutions staff'), staffForm),
    h('p', { class: 'notice' }, 'Prototype notice: this portal runs entirely in your browser and stores data on this device only. Clients and staff on different computers will not see each other’s data until a server backend is connected. Do not upload highly sensitive records (SSNs, bank logins) until then. Use Backup & restore (staff) to move data between devices.')));
}

/* ---------- shared widgets ---------- */
function tabs(names, active, onpick) {
  return h('div', { class: 'tabs', role: 'tablist' }, names.map(n =>
    h('button', { role: 'tab', 'aria-selected': String(n === active), onclick: () => onpick(n) }, n)));
}
async function downloadFile(f) {
  const url = URL.createObjectURL(f.blob);
  const a = h('a', { href: url, download: f.name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const MAX = 15 * 1024 * 1024;
async function saveFiles(fileList, base) {
  for (const f of fileList) {
    if (f.size > MAX) { toast(f.name + ' is over 15 MB and was skipped.'); continue; }
    await put('files', { ...base, id: uid(), name: f.name, type: f.type, size: f.size, blob: f, date: today() });
  }
}
function filesTable(files, { canDelete, onChange }) {
  if (!files.length) return h('p', { class: 'empty' }, 'Nothing here yet.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['File', 'Period', 'Added', 'Size', ''].map(t => h('th', {}, t)))),
    h('tbody', {}, files.sort((a, b) => b.date.localeCompare(a.date)).map(f => h('tr', {},
      h('td', {}, f.name, f.note ? h('div', { class: 'muted' }, f.note) : null),
      h('td', {}, f.period || '—'), h('td', {}, fmtDate(f.date)), h('td', {}, fmtSize(f.size)),
      h('td', {}, h('button', { class: 'btn sm sec', onclick: () => downloadFile(f) }, 'Download'), ' ',
        canDelete ? h('button', { class: 'btn sm danger', onclick: async () => { if (confirm('Delete ' + f.name + '?')) { await del('files', f.id); onChange(); } } }, 'Delete') : null)))));
}
function requestsTable(reqs, { client, onChange, staff }) {
  if (!reqs.length) return h('p', { class: 'empty' }, 'No requests.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Request', 'Due', 'Status', ''].map(t => h('th', {}, t)))),
    h('tbody', {}, reqs.sort((a, b) => (a.status === b.status ? (a.due || '9').localeCompare(b.due || '9') : a.status === 'open' ? -1 : 1)).map(r => {
      const late = r.status === 'open' && r.due && r.due < today();
      return h('tr', {}, h('td', {}, r.title), h('td', {}, fmtDate(r.due) || '—'),
        h('td', {}, h('span', { class: 'pill ' + (late ? 'late' : r.status) }, late ? 'Overdue' : r.status === 'open' ? 'Open' : 'Done')),
        h('td', {}, h('button', { class: 'btn sm sec', onclick: async () => { r.status = r.status === 'open' ? 'done' : 'open'; await put('requests', r); onChange(); } }, r.status === 'open' ? 'Mark done' : 'Reopen'), ' ',
          staff ? h('button', { class: 'btn sm danger', onclick: async () => { await del('requests', r.id); onChange(); } }, 'Remove') : null));
    })));
}
async function messagesPanel(client, from, rerender) {
  const msgs = (await all('messages')).filter(m => m.clientId === client.id).sort((a, b) => a.date.localeCompare(b.date));
  const box = h('div', { class: 'msgs' }, msgs.length ? msgs.map(m => h('div', { class: 'msg' + (m.from === from ? ' me' : '') },
    m.text, h('time', {}, (m.from === 'staff' ? 'RA Ledger' : client.name) + ' · ' + new Date(m.date).toLocaleString()))) : h('p', { class: 'empty' }, 'No messages yet.'));
  const ta = h('textarea', { rows: 3, required: true, 'aria-label': 'Message' });
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    await put('messages', { id: uid(), clientId: client.id, from, text: ta.value.trim(), date: new Date().toISOString() }); rerender();
  } }, ta, h('div', {}, h('button', { class: 'btn' }, 'Send')));
  setTimeout(() => { box.scrollTop = box.scrollHeight; });
  return h('div', {}, box, form);
}
function uploadForm({ withPeriod, label, onSubmit }) {
  const file = h('input', { type: 'file', multiple: true, required: true });
  const period = withPeriod ? h('input', { type: 'month', value: today().slice(0, 7) }) : null;
  const note = h('input', { type: 'text', maxlength: 140, placeholder: 'Optional note' });
  return h('form', { class: 'stack', onsubmit: async e => { e.preventDefault(); await onSubmit([...file.files], period?.value || '', note.value.trim()); } },
    h('label', {}, label, file), h('div', { class: 'row' }, withPeriod ? h('label', {}, 'Period', period) : null, h('label', {}, 'Note', note)),
    h('div', {}, h('button', { class: 'btn' }, 'Upload')));
}

/* ---------- client view ---------- */
async function clientView(client, tab = 'Overview') {
  const files = (await all('files')).filter(f => f.clientId === client.id);
  const reqs = (await all('requests')).filter(r => r.clientId === client.id);
  const reports = files.filter(f => f.kind === 'report'), docs = files.filter(f => f.kind === 'doc');
  const open = reqs.filter(r => r.status === 'open');
  const again = t => { $app.replaceChildren(); clientView(client, t || tab); };
  let body;
  if (tab === 'Overview') {
    body = h('div', {}, h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'stat' }, open.length), 'open requests from your accountant'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, reports.length), 'reports available'),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, docs.length), 'documents you’ve sent')),
      h('div', { class: 'card' }, h('h2', {}, 'Needs your attention'), open.length ? requestsTable(open, { client, onChange: again }) : h('p', { class: 'empty' }, 'You’re all caught up.')));
  } else if (tab === 'Reports') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Monthly reports'), filesTable(reports, { onChange: again }));
  } else if (tab === 'Documents') {
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'Send documents'), h('p', { class: 'muted' }, 'Bank and card statements, receipts, invoices, payroll records. Up to 15 MB per file.'),
      uploadForm({ withPeriod: true, label: 'Choose files', onSubmit: async (fl, p, n) => { await saveFiles(fl, { clientId: client.id, kind: 'doc', period: p, note: n, by: 'client' }); toast('Uploaded.'); again(); } })),
      h('div', { class: 'card' }, h('h2', {}, 'Your uploads'), filesTable(docs, { canDelete: true, onChange: again })));
  } else if (tab === 'Requests') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Requests'), requestsTable(reqs, { client, onChange: again }));
  } else {
    body = h('div', { class: 'card' }, h('h2', {}, 'Messages'), await messagesPanel(client, 'client', () => again('Messages')));
  }
  $app.replaceChildren(h('h1', {}, 'Welcome, ' + client.name), tabs(['Overview', 'Reports', 'Documents', 'Requests', 'Messages'], tab, again), body);
}

/* ---------- staff view ---------- */
async function staffView(state = {}) {
  const re = s => { $app.replaceChildren(); staffView(s ?? state); };
  const clients = (await all('clients')).sort((a, b) => a.name.localeCompare(b.name));
  if (state.clientId) {
    const c = clients.find(x => x.id === state.clientId);
    if (c) return staffClient(c, state.tab || 'Reports', re);
  }
  const files = await all('files'), reqs = await all('requests'), msgs = await all('messages');
  const rows = clients.map(c => {
    const openN = reqs.filter(r => r.clientId === c.id && r.status === 'open').length;
    const last = msgs.filter(m => m.clientId === c.id).sort((a, b) => b.date.localeCompare(a.date))[0];
    return h('tr', {}, h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, c.contact || '')),
      h('td', {}, files.filter(f => f.clientId === c.id && f.by === 'client').length + ' docs'),
      h('td', {}, openN ? h('span', { class: 'pill open' }, openN + ' open') : h('span', { class: 'pill done' }, 'none')),
      h('td', {}, last ? (last.from === 'client' ? 'Client: ' : 'You: ') + last.text.slice(0, 40) : '—'),
      h('td', {}, h('button', { class: 'btn sm', onclick: () => re({ clientId: c.id }) }, 'Open')));
  });
  const name = h('input', { required: true }), contact = h('input', { placeholder: 'Contact name / email' }), code = h('input', { required: true, minlength: 6, placeholder: 'Min 6 characters' });
  const addForm = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const id = uid();
    await put('clients', { id, name: name.value.trim(), contact: contact.value.trim(), hash: await sha(id + code.value.trim()), created: today() });
    toast('Client added. Give them the access code securely.'); re({});
  } }, h('div', { class: 'row' }, h('label', {}, 'Company name', name), h('label', {}, 'Contact', contact), h('label', {}, 'Access code', code)), h('div', {}, h('button', { class: 'btn' }, 'Add client')));

  const restore = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async e => { try { await importBackup(e.target.files[0]); toast('Backup restored.'); route(); } catch (err) { toast('Restore failed: ' + err.message); } } });
  $app.replaceChildren(h('h1', {}, 'Clients'),
    h('div', { class: 'card' }, clients.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Client', 'Uploads', 'Requests', 'Last message', ''].map(t => h('th', {}, t)))), h('tbody', {}, rows)) : h('p', { class: 'empty' }, 'No clients yet. Add your first one below.')),
    h('div', { class: 'card' }, h('h2', {}, 'Add a client'), addForm),
    h('div', { class: 'card' }, h('h2', {}, 'Backup & restore'), h('p', { class: 'muted' }, 'Data is stored in this browser only. Export regularly; restore replaces everything on this device.'),
      h('button', { class: 'btn sec', onclick: exportBackup }, 'Export backup'), ' ', h('button', { class: 'btn sec', onclick: () => restore.click() }, 'Restore from backup'), restore));
}

async function staffClient(c, tab, re) {
  const files = (await all('files')).filter(f => f.clientId === c.id);
  const reqs = (await all('requests')).filter(r => r.clientId === c.id);
  const here = t => re({ clientId: c.id, tab: t || tab });
  let body;
  if (tab === 'Reports') {
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'Publish a report'),
      uploadForm({ withPeriod: true, label: 'Report files (P&L, balance sheet, etc.)', onSubmit: async (fl, p, n) => { await saveFiles(fl, { clientId: c.id, kind: 'report', period: p, note: n, by: 'staff' }); toast('Published.'); here(); } })),
      h('div', { class: 'card' }, h('h2', {}, 'Published reports'), filesTable(files.filter(f => f.kind === 'report'), { canDelete: true, onChange: here })));
  } else if (tab === 'Client uploads') {
    body = h('div', { class: 'card' }, h('h2', {}, 'Documents from ' + c.name), filesTable(files.filter(f => f.kind === 'doc'), { canDelete: true, onChange: here }));
  } else if (tab === 'Requests') {
    const title = h('input', { required: true, placeholder: 'e.g. March bank statement' }), due = h('input', { type: 'date' });
    body = h('div', {}, h('div', { class: 'card' }, h('h2', {}, 'New request'), h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault(); await put('requests', { id: uid(), clientId: c.id, title: title.value.trim(), due: due.value, status: 'open', created: today() }); here();
    } }, h('div', { class: 'row' }, h('label', {}, 'What do you need?', title), h('label', {}, 'Due', due)), h('div', {}, h('button', { class: 'btn' }, 'Send request')))),
      h('div', { class: 'card' }, h('h2', {}, 'All requests'), requestsTable(reqs, { client: c, onChange: here, staff: true })));
  } else {
    body = h('div', { class: 'card' }, h('h2', {}, 'Messages'), await messagesPanel(c, 'staff', () => here('Messages')));
  }
  const danger = h('button', { class: 'btn danger sm', onclick: async () => {
    if (!confirm('Delete ' + c.name + ' and ALL their files, requests and messages?')) return;
    for (const f of files) await del('files', f.id);
    for (const r of reqs) await del('requests', r.id);
    for (const m of (await all('messages')).filter(m => m.clientId === c.id)) await del('messages', m.id);
    await del('clients', c.id); re({});
  } }, 'Delete client');
  $app.replaceChildren(h('p', {}, h('button', { class: 'btn sm sec', onclick: () => re({}) }, '← All clients')),
    h('div', { class: 'row' }, h('h1', {}, c.name), h('div', { style: 'flex:0 0 auto' }, danger)),
    tabs(['Reports', 'Client uploads', 'Requests', 'Messages'], tab, here), body);
}

/* ---------- backup ---------- */
const b64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
async function exportBackup() {
  const out = { version: 1, exported: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  out.files = await Promise.all(out.files.map(async f => ({ ...f, blob: await b64(f.blob) })));
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  downloadFile({ blob, name: 'ra-portal-backup-' + today() + '.json' });
}
async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.version !== 1) throw new Error('unrecognized file');
  if (!confirm('This replaces all portal data on this device. Continue?')) return;
  for (const s of STORES) for (const o of await all(s)) await del(s, o.id);
  for (const s of STORES) for (const o of data[s] || []) {
    if (s === 'files') o.blob = await (await fetch(o.blob)).blob();
    await put(s, o);
  }
  session.clear();
}

route().catch(e => { $app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Portal unavailable'), h('p', {}, 'This browser blocked local storage (private mode?). ' + e.message))); });
