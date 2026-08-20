const CACHE_NAME = 'caminadora-v2';
const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './ble.js',
  './motor.js',
  './editor.js',
  './extras.js',
  './plan_semanal.json',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Red primero (para no quedar pegado en versiones viejas mientras la app
// esta en desarrollo activo); si no hay conexion, usa lo cacheado.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request)),
  );
});
