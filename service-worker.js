// Service worker de Scoutdrive.
//
// Estrategia: "red primero, caché como red de seguridad" para el shell de
// la app (HTML/CSS/JS/iconos/librerías), y SIEMPRE red — sin caché — para
// las llamadas al backend (Google Apps Script, que es donde viven los
// datos reales de jugadores/equipos/partidos y el login).
//
// Con conexión, la app siempre pide la versión más reciente del shell a
// la red (igual que antes) y, de paso, la va guardando en caché. Sin
// conexión, en vez de una pantalla en blanco, se sirve la última versión
// del shell que se guardó — así el cuerpo técnico puede al menos abrir la
// app y consultar lo que ya se había cargado, aunque no pueda traer datos
// nuevos hasta recuperar cobertura.

const CACHE_NAME = 'scoutdrive-shell-v1';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-any-192.png',
  './icon-any-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './sync-bridge.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // No bloqueamos la instalación si algún recurso externo falla al
      // precachear (p.ej. un CDN caído justo en ese instante) — cacheamos
      // los que se puedan y seguimos con los demás.
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] No se pudo precachear', url, err);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Limpiamos cachés de versiones antiguas del service worker.
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
    ])
  );
});

// Las llamadas al backend de datos (Google Apps Script) nunca se cachean:
// siempre deben ir a la red, para no mostrar nunca datos ni resultados de
// login desactualizados.
function esLlamadaBackend(url) {
  return url.includes('script.google.com');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo interceptamos peticiones GET del propio shell. Todo lo demás
  // (POST al backend, llamadas GET al backend, etc.) va directo a la red,
  // sin pasar por caché.
  if (req.method !== 'GET' || esLlamadaBackend(req.url)) {
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Con red disponible, servimos y guardamos siempre la versión
        // fresca — así la caché nunca se queda más desactualizada que la
        // última vez que hubo conexión.
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        }
        return res;
      })
      .catch(() =>
        // Sin red: servimos lo último que tengamos en caché. Si tampoco
        // hay nada cacheado para esa URL, dejamos que el error se
        // propague de forma normal (igual que sin service worker).
        caches.match(req).then((cached) => cached || Promise.reject(new Error('sin-cache-ni-red')))
      )
  );
});
