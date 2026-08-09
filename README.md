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
- `@pickpoint/sdk/tracking` — realtime tracks (`tracking.v2` protobuf)

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

Binary WebSocket + `tracking.v2` protobuf. Works in **browsers** (global `WebSocket`) and **Node** (`ws`).

```ts
import { connect } from '@pickpoint/sdk/tracking'

const client = await connect({
  endpoint: 'wss://tracking.pickpoint.io',
  auth: { clientId: '...', clientSecret: '...' },
})

const trackUid = await client.startTrack({
  location: { latitude: 55.75, longitude: 37.61 },
})

client.publish({ latitude: 55.76, longitude: 37.62 })

client.on('location', (msg) => {
  console.log(msg.deviceUid, msg.point)
})

client.close()
```

### Reconnect / resume

After an unexpected drop the client reconnects with full-jitter backoff and sends **`resume(trackUid, clientSeq)`** — never an implicit `track_start`. Offline points are queued (drop-oldest) and flushed after `ResumeOk`.

| Server signal | Client behavior |
|---------------|-----------------|
| `ResumeOk` | Ack queue through `last_acked_seq`, flush remainder |
| `TRACK_NOT_FOUND` / `FENCED` | Clear track cursor |
| `Relocate` | Dial new `endpoint` (honor `retry_after_ms`) |
| `AUTH` / `UNAUTHORIZED` | Call `refreshAuth` if provided, else stop |

Protocol: [`pickpoint-proto`](https://github.com/pickpoint/pickpoint-proto).

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

- **PR** → `.github/workflows/ci.yml` (typecheck, test, build on Node 20/22)
- **Push to `main`** (untagged HEAD) → bump **patch**, tag `vX.Y.Z`, `npm publish` (OIDC) + GitHub Release in the same job  
  (tag push via `GITHUB_TOKEN` does not start new workflows — publish cannot wait on the tag event)
- **Manual tag `v*`** (pushed by a human) → publish + GitHub Release

Minor/major: bump `version` in a PR, merge with `[skip release]` in the commit message, then:

```bash
git tag v2.2.0
git push origin v2.2.0
```

Regenerate protobuf stubs (needs sibling `../pickpoint-proto` + `protoc`):

```bash
npm run gen
```

