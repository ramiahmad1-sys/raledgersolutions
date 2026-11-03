/* Service worker: makes the portal installable and shows a friendly screen when offline.
   It caches only the app's own static files (page shell, scripts, styles, icons) so the app opens quickly.
   It NEVER caches /api/ responses or invoices/documents, so no client data is stored on the phone by the app.
   Static files are fetched from the network first, so updates reach everyone immediately. */
const CACHE = 'ra-portal-shell-v1';
const SHELL = ['/portal/', '/portal/portal.css', '/portal/portal.js', '/portal/billing.js', '/portal/offline.html',
  '/portal/icons/icon-192.png', '/portal/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (!url.pathname.startsWith('/portal/')) return;                 // API, website and everything else: untouched
  if (url.pathname === '/portal/sw.js') return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('/portal/offline.html');
      return Response.error();
    }));
});
