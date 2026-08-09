# pickpoint-js

Published as **`@pickpoint/sdk`** (Apache-2.0).

One dependency for Pickpoint clients:

```bash
npm i @pickpoint/sdk
```

```ts
import { connect } from '@pickpoint/sdk/tracking'
```

## Status

| Module | Status |
|--------|--------|
| `@pickpoint/sdk/tracking` | stub (WS + `tracking.v2` next) |
| `@pickpoint/sdk/geocoding` etc. | reserved — likely gRPC/batch for bulk, not classic REST fan-out |

Protocol source: [`pickpoint-proto`](https://github.com/pickpoint/pickpoint-proto).

## Local layout

Sibling of the private monorepo:

```text
Projects/
  pickpoint/
  pickpoint-sdk/
    pickpoint-proto/
    pickpoint-js/    # this repo
    go-sdk/
```
