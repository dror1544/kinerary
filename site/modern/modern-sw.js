const CACHE = "kinerary-modern-v1";
const SHELL = ["./", "./index.html"];
const READ_ONLY_API = [
  "/api/config",
  "/api/ui-settings",
  "/api/itinerary/active",
  "/api/today",
  "/api/confirmations/summary",
  "/api/operations/flights",
  "/api/hermes/status",
  "/api/moments",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const isReadOnlyApi = READ_ONLY_API.some((path) => url.pathname.endsWith(path));
  if (request.mode === "navigate" || isReadOnlyApi || url.pathname.includes("/modern/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html"))),
    );
  }
});
