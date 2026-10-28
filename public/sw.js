// Service worker minimal : rend Maestro installable comme une app et ouvre la bonne vue au clic sur une notification.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.path || '#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        c.postMessage({ type: 'navigate', path });
        return c.focus();
      }
      return self.clients.openWindow(`/${path}`);
    }),
  );
});
