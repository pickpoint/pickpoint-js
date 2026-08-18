# @pickpoint/sdk

Official JavaScript/TypeScript SDK for [Pickpoint](https://pickpoint.io) — a geolocation platform with four APIs under one key:

| API | What it does |
|-----|----------------|
| **Geocoding** | Address ↔ coordinates (forward, reverse, place lookup) |
| **Address search** | Typeahead / autocomplete for address inputs |
| **Routing** | Routes, matrices, optimized multi-stop, elevation |
| **Device tracking** | Register devices over HTTP; stream live GPS over WebSocket |

Built for maps, delivery, logistics, and anything that needs places, routes, or live location. Data is OpenStreetMap-backed; responses are plain JSON / GeoJSON. Docs: [pickpoint.io/docs](https://pickpoint.io/docs).

**This package** wraps that surface so you do not hand-roll `fetch` / WebSocket framing:

- `PickPoint` — HTTP client for geocode, search, routing, devices (+ `clientAuth` for SPAs)
- `@pickpoint/sdk/tracking` — live GPS over WebSocket (`tracking.v2`)

Apache-2.0. Go sibling: [`github.com/pickpoint/go-sdk`](https://github.com/pickpoint/go-sdk).

```bash
npm i @pickpoint/sdk
```

## Quick start — `PickPoint`

One client, one auth session, whole public HTTP API.

```ts
import { PickPoint } from '@pickpoint/sdk'

// Browser: pair from YOUR backend (see clientAuth below)
const pp = new PickPoint({
  clientAuth: {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt, // unix ms
  },
})

// Flat shortcuts (also safe to destructure — methods are bound)
await pp.forward({ q: 'Berlin' })
await pp.reverse({ lat: 52.5, lon: 13.4 })
await pp.search({ q: 'Berlin' })          // address autocomplete
await pp.route({ locations: [/* … */] }) // Valhalla body
await pp.devices.list()

const { forward, search } = pp
await forward({ q: 'Paris' })

// Namespaced (clearer in larger apps)
await pp.geocoding.lookup({ osm_ids: 'R62422' })
await pp.routing.matrix({ /* … */ })
await pp.devices.command(uid, new TextEncoder().encode('ping'))

pp.close()
```

**Style tip:** use `pp.forward(...)` day-to-day; prefer `pp.devices.*` / `pp.routing.*` for domains with generic verbs (`list`, `get`, `route`). Destructuring works because shortcuts are arrow class fields.

Tracking (live WebSocket) is separate: `@pickpoint/sdk/tracking`.

### Security: never put a secret API key in the browser

| Environment | How to auth |
|-------------|-------------|
| **Node / your backend** | `apiKey` (`x-api-key`) OK |
| **Browser / embedded web app** | `clientAuth` pair from **your** backend |

```ts
// Node
const pp = new PickPoint({ apiKey: process.env.PICKPOINT_API_KEY! })
```

### `clientAuth` (integrator SPA)

```ts
// ——— Your backend, after session check ———
// POST https://api.pickpoint.io/v2/client-tokens
// Headers: x-api-key: <SECRET>
// Body: { "scopes": ["geocoding", "address", "routing", "devices"], "ttlSec": 600 }
//   or omit scopes → all client-tokenable permissions on the key
// → { accessToken, refreshToken, expiresAt, expiresIn, scopes }

const pair = await fetch('/api/pickpoint/client-tokens', { credentials: 'include' })
  .then((r) => r.json())

const pp = new PickPoint({
  clientAuth: {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: pair.expiresAt,
  },
})
```

| Scope on mint | SDK surface |
|---------------|-------------|
| `geocoding` | `forward` / `reverse` / `lookup` |
| `address` | `search` |
| `routing` | `route` / `optimizedRoute` / `matrix` / `locate` / `elevation` |
| `devices` | `devices.*` |
| — | `/v2/api-keys*` **not** allowed with client tokens |

SDK refreshes at **~50% of access TTL** (single-flight) and once on HTTP **401**.

### Batch geocoding

Pass an array (max **20** in flight; keep-alive via undici on Node):

```ts
await pp.forward([{ q: 'Paris' }, { q: 'Rome' }])
await pp.geocoding.batch.reverse([{ lat: 48.85, lon: 2.35 }])
```

| Response | Geocode batch slot |
|----------|--------------------|
| `2xx` | parsed JSON |
| `400` / other `4xx` (except auth) | empty (`[]` / `null`) |
| `401` | refresh once; else abort |
| `402` / `403` | abort, `ApiAuthError` |
| `≥500` / network | retry then throw |

Address / routing / devices throw `ApiError` on 4xx (with `status` + `body`) instead of empty slots.

## Tracking

Live GPS is a **separate** WebSocket session (`@pickpoint/sdk/tracking`): `wss://tracking.pickpoint.io/v2/ws`, subprotocol `tracking.v2`. Works in browsers (global `WebSocket`) and Node (`ws`).

A dropped socket is not a new trip. The SDK reconnects and **Resumes** the same `track_uid`.

First `publish` starts the trip if none is live. `close` sends `TrackStop` then hangs up. Call `startTrack` only to supersede (new order / `TRACK_NOT_FOUND`) or to set a route.

### Device (publisher)

```ts
import { connect } from '@pickpoint/sdk/tracking'

const session = await connect({
  endpoint: 'wss://tracking.pickpoint.io', // host; SDK appends /v2/ws
  auth: { clientId: deviceUid, clientSecret: deviceSecret }, // from devices.create
})

session.publish({ latitude: 55.75, longitude: 37.61 }) // TrackStart if idle
session.close() // TrackStop + hang up
```

### Listener (dashboard)

`accessToken` is the **client-token** from `POST /v2/client-tokens` (scope `devices`) — same `pair.accessToken` as HTTP `clientAuth`. Mint it on your backend; never put the API key in the browser.

```ts
const session = await connect({
  endpoint: 'wss://tracking.pickpoint.io',
  auth: { accessToken: pair.accessToken },
  subscribe: deviceUid,
})

session.on('location', (msg) => {
  console.log(msg.point.latitude, msg.point.longitude) // live fan-out; publisher never sees Loc
})
```

Wire format: [`pickpoint-proto`](https://github.com/pickpoint/pickpoint-proto).

## Develop

```bash
npm i
npm test
npm run build
```

Live geocode batch e2e (suite skipped unless the key is set):

```bash
PICKPOINT_API_KEY=… npm test -- test/e2e-geocode-batch.test.ts
# optional: PICKPOINT_BASE_URL=https://api.pickpoint.io
```

### CI & release

- **PR to `dev`** → `.github/workflows/ci.yml` (typecheck, test, build on Node 20/22)
- **Merge `dev` → `main`** (untagged HEAD) → bump **patch**, tag `vX.Y.Z`, `npm publish` (OIDC) + GitHub Release in the same job  
  (tag push via `GITHUB_TOKEN` does not start new workflows — publish cannot wait on the tag event)
- **Manual tag `v*`** (pushed by a human) → publish + GitHub Release

Minor/major: bump `version` in a PR, merge with `[skip release]` in the commit message, then:

```bash
git tag v2.2.0
git push origin v2.2.0
```

## Contributing

Fork and open a PR against **`dev`**. [CONTRIBUTING.md](CONTRIBUTING.md).

