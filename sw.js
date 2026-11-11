// Cache do app para funcionar offline. Os dados importados ficam no armazenamento do navegador.
const CACHE = 'faturamento-google-v3';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'xlsx.js', 'model.js', 'charts.js', 'app.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'logo-cosampa.png'];

self.addEventListener('install', e => {
  // Se o cache falhar (disco cheio, modo privado), o app continua funcionando online.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Rede primeiro (pega versões novas do app); sem rede, usa o cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
