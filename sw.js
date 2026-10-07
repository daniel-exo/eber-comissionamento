// Service worker: guarda o app e os dados no aparelho para abrir sem internet.
// Estratégia "stale-while-revalidate": abre na hora com o que está guardado e busca a versão nova
// em segundo plano (vale a partir da próxima abertura). O tráfego do Firebase não passa por aqui.
const CACHE = 'eber-comiss-v10';
// Essenciais: o app precisa de todos para abrir. Opcionais: se faltarem, o app abre mesmo assim.
const ESSENCIAIS = [
  './', 'index.html', 'app.css',
  'js/app.js', 'js/store.js', 'js/firebase-config.js', 'js/vendor/firebase.js',
  'dados/listas.json', 'dados/areas.json',
  'dados/area-200.json', 'dados/area-300.json', 'dados/area-400.json', 'dados/area-700.json',
];
const OPCIONAIS = [
  'manifest.webmanifest', 'dados/acoes.json',
  'icones/logo.png', 'icones/exo.png', 'icones/exo-escuro.png', 'icones/eber-branco.png', 'icones/icone-192.png', 'icones/icone-512.png',
];
self.addEventListener('install', e => {
  // Os essenciais entram todos ou nenhum. Se um download falhar (sinal fraco, arquivo ausente), a instalação
  // é cancelada: a versão anterior continua valendo, com a cópia completa dela, e o navegador tenta de novo
  // na próxima abertura. Só depois de tudo baixado a versão nova assume e a cópia antiga é apagada.
  // cache: 'reload' busca direto no servidor, sem reaproveitar cópia antiga do navegador.
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.all(ESSENCIAIS.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await Promise.all(OPCIONAIS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)));
  }).then(() => self.skipWaiting()));
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
  if (url.origin === self.location.origin && url.searchParams.has('fresco')) {
    // pedido da versão atual (lista de ações): vai direto ao servidor e, se der certo, renova a cópia guardada.
    // Sem conexão, falha; o app continua com a cópia que já tem.
    e.respondWith(fetch(req, { cache: 'no-store' }).then(async r => {
      if (r && r.ok) { const c = await caches.open(CACHE); await c.put(url.origin + url.pathname, r.clone()); }
      return r;
    }).catch(() => Response.error()));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const guardado = await c.match(req, { ignoreSearch: true });
    const rede = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
    if (guardado) { e.waitUntil(rede); return guardado; }
    const r = await rede;
    return r || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
  }));
});
