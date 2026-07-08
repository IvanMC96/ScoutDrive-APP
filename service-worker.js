// Service worker mínimo de Scoutdrive.
// Solo existe para que el navegador considere la web "instalable" como
// app (Chrome/Android exigen un service worker con un listener de
// 'fetch' para ofrecer el botón "Instalar"). A propósito NO cachea
// nada: la app siempre pide los datos más recientes al servidor, para
// no arriesgarnos a que alguien vea una versión vieja de la web o de
// los datos por culpa de una caché desactualizada.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pasarela directa a la red, sin caché.
  event.respondWith(fetch(event.request));
});
