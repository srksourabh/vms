/** Register the PWA service worker in production builds only.
 *  Dev (`npm run dev`) must not cache — it would hide hot-reload. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Installability is optional; login still works in the browser. */
    });
  });
}
