// Service worker: guarda o app e os dados no aparelho para abrir sem internet.
// Estratégia "stale-while-revalidate": abre na hora com o que está guardado e busca a versão nova
// em segundo plano (vale a partir da próxima abertura). O tráfego do Firebase não passa por aqui.
const CACHE = 'eber-comiss-v4';
const ARQUIVOS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/firebase-config.js', 'js/vendor/firebase.js',
  'dados/listas.json', 'dados/areas.json',
  'dados/area-200.json', 'dados/area-300.json', 'dados/area-400.json', 'dados/area-700.json',
  'icones/logo.png', 'icones/exo.png', 'icones/icone-192.png', 'icones/icone-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fontes = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !fontes) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const guardado = await c.match(req, { ignoreSearch: true });
    const rede = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
    if (guardado) { e.waitUntil(rede); return guardado; }
    const r = await rede;
    return r || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
  }));
});
