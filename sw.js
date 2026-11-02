// Sucata Livre · service worker mínimo: só deixa o app ser instalado no celular.
// Não guarda nada em cache: cada página vem sempre da rede, para a faixa de "versão nova" continuar valendo.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request));
});
