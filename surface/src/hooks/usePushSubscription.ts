import { useEffect, useRef } from 'react';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const buf = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function usePushSubscription() {
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    (async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const existing = await reg.pushManager.getSubscription();
        if (existing) return; // already subscribed

        const res = await fetch('/api/push/vapid-key');
        if (!res.ok) return;
        const { publicKey } = await res.json();

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });

        console.log('[push] Subscribed successfully');
      } catch (err) {
        console.warn('[push] Subscription failed:', err);
      }
    })();
  }, []);
}
