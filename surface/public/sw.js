// Aria service worker — handles push notifications and deep linking

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  const { message, sender, important, urgent } = data;

  // Title matches the CLI pattern: ARIA, ARIA [!], ARIA [!!]
  let title = 'Aria';
  if (urgent && important) title = 'Aria [!!]';
  else if (urgent || important) title = 'Aria [!]';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: message || 'New update',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: sender || 'aria',
      data: { url: sender ? '/objectives/' + sender : '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // If Aria is already open, focus and navigate
      for (const win of wins) {
        if (new URL(win.url).origin === self.location.origin) {
          win.focus();
          win.navigate(self.location.origin + url);
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});
