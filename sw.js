/**
 * Service Worker — CXR TO DO
 *
 * ⚠️ CEA MAI FRECVENTĂ CALE DE A-ȚI BLOCA UTILIZATORII
 * Un SW care servește HTML din cache îi ține pe o versiune veche
 * PERMANENT: browserul primește HTML-ul vechi, care referă JS vechi,
 * iar SW-ul nou nu ajunge niciodată să fie descărcat. Singura ieșire
 * e ca utilizatorul să șteargă datele site-ului — ceea ce nu va face,
 * fiindcă nu știe că problema există.
 *
 * De aceea: HTML = NETWORK FIRST, întotdeauna.
 *
 * ⚠️ CE NU SE CACHEAZĂ NICIODATĂ
 * Răspunsurile de la Supabase conțin date personale. Un cache pe
 * disc, partajat pe un dispozitiv folosit de mai mulți oameni, ar
 * expune rutinele unui utilizator altuia. Datele stau în IndexedDB,
 * izolate per utilizator, nu în Cache API.
 */

const VERSION = 'v1'
const STATIC_CACHE = `cxr-static-${VERSION}`
const RUNTIME_CACHE = `cxr-runtime-${VERSION}`

/**
 * Ce se preîncarcă la instalare.
 *
 * ⚠️ Deliberat MINIM. Fiecare intrare care dă 404 face întreaga
 * instalare să eșueze, iar SW-ul nu se activează deloc. Restul se
 * cachează la prima cerere.
 */
// ⚠️ SLASH FINAL OBLIGATORIU.
//
// `next.config.mjs` are `trailingSlash: true`, deci exportul static
// generează `out/offline/index.html`, servit la `/offline/`.
//
// `cache.add('/offline')` primește un 301. Cache API stochează
// RĂSPUNSUL DE REDIRECT, nu pagina — iar la următoarea folosire
// offline, `caches.match` întoarce un redirect pe care browserul nu-l
// poate urma fără rețea.
//
// Rezultatul: utilizatorul vede eroarea implicită de browser, exact
// în situația pentru care pagina offline a fost construită.
const PRECACHE = ['/offline/', '/manifest.json']

/** Cereri care NU trec niciodată prin cache. */
function isNeverCached(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('sentry.io') ||
    url.pathname.startsWith('/_next/webpack-hmr')
  )
}

/** Resurse cu hash în nume: conținutul nu se schimbă niciodată. */
function isImmutable(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    /\.(woff2?|ttf|otf)$/.test(url.pathname)
  )
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(cache =>
        // `addAll` e atomic: dacă o intrare pică, toată operația
        // eșuează. Adăugăm individual, ignorând eșecurile.
        Promise.allSettled(PRECACHE.map(url => cache.add(url)))
      )
      // Noul SW preia imediat, fără să aștepte închiderea tuturor
      // filelor. Sigur pentru că nu servim HTML din cache.
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('cxr-') && !key.endsWith(VERSION))
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event

  // POST, PUT, DELETE nu se cachează niciodată.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Alt origin decât al nostru: lăsăm browserul să decidă.
  if (url.origin !== self.location.origin) return

  if (isNeverCached(url)) return

  // ── HTML: rețea prima, cache doar ca plasă de siguranță ──
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Păstrăm o copie DOAR pentru cazul offline. Nu o servim
          // cât timp rețeaua răspunde.
          const copy = response.clone()
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy))
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          if (cached) return cached
          // Aceeași cheie ca la precache. O nepotrivire aici face
          // `match` să întoarcă `undefined`, tăcut.
          const offline = await caches.match('/offline/')
          return (
            offline ??
            new Response('Offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          )
        })
    )
    return
  }

  // ── Resurse cu hash: cache prima, sunt imuabile ──
  if (isImmutable(url)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached
        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(STATIC_CACHE).then(cache => cache.put(request, copy))
          }
          return response
        })
      })
    )
    return
  }

  // ── Restul: cache vechi imediat, actualizare în fundal ──
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(RUNTIME_CACHE).then(cache => cache.put(request, copy))
          }
          return response
        })
        .catch(() => cached)

      return cached ?? network
    })
  )
})

/**
 * Mesaje de la pagină.
 *
 * `SKIP_WAITING` permite utilizatorului să aplice o versiune nouă
 * fără să închidă toate filele.
 */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => {
      keys.filter(k => k.startsWith('cxr-')).forEach(k => caches.delete(k))
    })
  }
})

/**
 * ⚠️ Background Sync NU e implementat aici.
 *
 * API-ul e disponibil doar în Chromium — Safari și Firefox nu îl au.
 * Iar coada offline din aplicație (`offlineQueue`) funcționează pe
 * toate, fiindcă rulează în pagină, nu în SW.
 *
 * A duplica logica de sincronizare în SW ar însemna două
 * implementări care trebuie ținute sincronizate, dintre care una
 * funcționează pentru jumătate din utilizatori.
 */
