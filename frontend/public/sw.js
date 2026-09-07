/* openGym service worker — runtime caching (works with Vite's hashed asset names).
   Media (img/gif) cache-first; everything else network-first with offline fallback. */
const CACHE = 'opengym-rt-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})
/* Push payloads come in two shapes and this must read both, in either direction: the server now
   sends the Declarative Web Push envelope ({ web_push: 8030, notification: {...} }) that Safari
   renders on its own, but a service worker already installed in a browser can be older than the
   server that sends to it, or newer than one not yet redeployed. Neither order may lose an alert.
   A throw in here would mean a delivered push with no visible notification, which is exactly what
   costs the subscription on iOS — hence the try/catch and the defaults on every field. */
self.addEventListener('push', e => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch { data = {} }
  const n = (data && data.notification) || data || {}
  e.waitUntil(self.registration.showNotification(n.title || 'openGym', {
    body: n.body || '',
    icon: 'icon-512.png',
    badge: 'icon-180.png',
    tag: n.tag || 'opengym',
    renotify: true,
    // Carried through so the click handler goes where the payload says, not always to the root.
    data: { navigate: n.navigate || './' }
  }))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  let target = self.location.href
  try { target = new URL((e.notification.data && e.notification.data.navigate) || './', self.location.href).href }
  catch { target = new URL('./', self.location.href).href }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const c = clients.find(c => 'focus' in c)
    // Reuse the window that is already open — a second copy of the app is never what you wanted —
    // and steer it to the target. `navigate` is unavailable on uncontrolled/cross-origin clients,
    // so a failure there leaves the existing window focused rather than dropping the click.
    if (!c) return self.clients.openWindow(target)
    return Promise.resolve(c.focus()).then(w => {
      const win = w || c
      if (win.url === target || typeof win.navigate !== 'function') return win
      return Promise.resolve(win.navigate(target)).catch(() => win)
    })
  }))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/')) return    // never cache auth/data

  const isMedia = url.pathname.includes('/img/') || url.pathname.includes('/gif/')
  if (isMedia) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res })
    )))
  } else {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)) }
      return res
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))))
  }
})
