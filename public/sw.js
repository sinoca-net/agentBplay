// Service worker: notificaciones push del chat
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // necesario para que sea instalable
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Nuevo mensaje', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Nuevo mensaje', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/chat' }, tag: 'chat', renotify: true,
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.includes('/chat') && 'focus' in c) return c.focus();
    return clients.openWindow(e.notification.data.url);
  }));
});
