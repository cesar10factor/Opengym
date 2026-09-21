/* openGym service worker — the app shell and its hashed assets are cached at install and kept
   fresh network-first, media (img/gif) cache-first. A home-screen app reopened without a network
   comes back from here with the same bundle it last ran; the state itself lives in localStorage.
   `CACHE` carries the build hash (vite.config.js rewrites it), so every deploy is a new worker
   with its own cache and the previous build's files are dropped on activate. */
const CACHE = 'opengym-rt-__BUILD__'

// What the shell needs to boot without a network: index.html plus every script/style/icon it
// references. Read from the served index.html so the list follows the build, not a hand-kept
// manifest that would go stale the first time a chunk is renamed.
async function precache() {
  const c = await caches.open(CACHE)
  const res = await fetch('index.html', { cache: 'no-cache' })
  if (!res.ok) return
  const html = await res.text()
  await c.put('index.html', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => /\.(?:js|css|png|svg|webmanifest|json)(?:\?|$)/.test(u) && !/^(?:https?:)?\/\//.test(u))
  await Promise.all([...new Set(refs)].map(u => c.add(u).catch(() => {})))
}

self.addEventListener('install', e => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})

// The payload is parsed inside waitUntil: a push whose handler throws before showing anything is
// a "silent push", which Chrome counts against the site and eventually revokes. A body that is
// not JSON still shows a notification.
//
// The payload itself may arrive flat (title/body/tag/navigate at the top level — what this server
// sends) or nested under `notification` — a service worker already installed can be older than the
// server sending to it, or newer than one not yet redeployed, and neither order may lose an alert.
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let data = {}
    try { data = e.data ? e.data.json() : {} } catch { data = { body: (() => { try { return e.data.text() } catch { return '' } })() } }
    const n = (data && data.notification) || data || {}
    const tag = n.tag || 'opengym'
    // Every notification this app sends is about right now: a same-tag one was not reliably
    // replaced by showNotification on iOS (issue #172), and an older, different-tag one (say a
    // stale day-reminder still sitting there) is never worth keeping once a fresher alert exists.
    // So the whole tray is cleared before painting the new one, rather than only the same tag.
    // Wrapped: getNotifications() failing must never be allowed to cost the notification itself.
    try { for (const old of await self.registration.getNotifications()) old.close() } catch {}
    await self.registration.showNotification(n.title || 'openGym', {
      body: n.body || '',
      icon: 'icon-512.png',
      badge: 'icon-180.png',
      tag,
      renotify: true,
      // Carried through so the click handler can go where the payload says, not always to root.
      data: { navigate: n.navigate || null }
    })
  })())
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  // `navigate` must never turn a notification into a redirect to somewhere else: same origin
  // only, anything unusable falls back to the app root. The app is a HashRouter
  // (frontend/src/App.jsx), so the workout screen is at /#/workout, not /workout.
  let target = new URL('./', self.location.href).href
  const raw = e.notification.data && e.notification.data.navigate
  if (raw) {
    try {
      const u = new URL(raw, self.location.href)
      if (u.origin === self.location.origin) target = u.href
    } catch { /* keep the root fallback */ }
  }
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(clients => {
    const c = clients.find(c => 'focus' in c)
    if (!c) return self.clients.openWindow(target)
    // Reuse the window that is already open rather than a second copy of the app, and steer it to
    // the target. `navigate` is unavailable on some clients, so a failure there leaves the
    // existing window focused rather than dropping the click.
    return Promise.resolve(c.focus()).then(w => {
      const win = w || c
      if (win.url === target || typeof win.navigate !== 'function') return win
      return Promise.resolve(win.navigate(target)).catch(() => win)
    })
  }))
})
// The push service rotated the subscription (key change, expiry): subscribe again with the same
// server key and tell the server, so the row it holds keeps pointing at this browser.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const old = e.oldSubscription || (await self.registration.pushManager.getSubscription())
    const key = e.newSubscription?.options?.applicationServerKey || old?.options?.applicationServerKey
    if (!key) return
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await fetch('api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) }).catch(() => {})
  })())
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
    return
  }
  // Network first; the copy for the cache is cloned before the response is handed to the page —
  // cloning later, once the page has started reading the body, throws and caches nothing, which
  // is why the shell never used to survive an offline reload.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}) }
    return res
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit =>
    hit || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined)
  )))
})
