// Service worker do Contro Vend (PWA).
// - /vendor/ (leitor zxing, ~360 KB) e /img/ (ícones): direto do cache, a câmera abre na hora.
// - Páginas, CSS e JS do app: sempre da rede, para a versão nova valer assim que publicada
//   (inclusive ao editar no PC); o cache só entra quando a rede falha.
// - API e URLs com parâmetros (ex.: link de troca de senha): nunca passam pelo cache.
// shortcut: zxing e ícones ficam no cache até este nome mudar; ao atualizar a biblioteca ou
// trocar os ícones, mude para 'contro-vend-v2'.
const CACHE = 'contro-vend-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.search) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNetwork = async () => {
      const response = await fetch(request);
      if (response.ok && !response.redirected) event.waitUntil(cache.put(request, response.clone()));
      return response;
    };
    if (/^\/(vendor|img)\//.test(url.pathname)) return (await cache.match(request)) || fromNetwork();
    try {
      return await fromNetwork();
    } catch (err) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});
