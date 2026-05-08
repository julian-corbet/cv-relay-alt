# relay-alt

Stateless WebSocket fan-out relay for CareerVector. Vendor-independent failover for the Cloudflare Durable Object relay (`apps/realtime`) when the DO is quota-exhausted or unavailable.

Implements the same wire protocol as the DO in thin-relay mode: binary frames are broadcast verbatim to every other socket in the same workspace group. No state, no parsing, no persistence.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws/<workspaceId>?userId=<id>` | `GET` (WS upgrade) | Join a workspace relay group |
| `/health` | `GET` | Health check; returns `{ status, rooms, connections, ts }` |

## Architecture

- Pure in-process fan-out via a `Map<wsId, Set<WebSocket>>`.
- Binary frames only — string frames are dropped (Yjs protocol is binary).
- No authentication, no workspace validation (same as the DO thin-relay).
- Stateless: no Yjs doc, no snapshots, no alarms.
- Workspace IDs accepted in the range `[4, 64]` characters.

## Live deployment

The canonical instance runs on **Deno Deploy** at `wss://careervector-relay-alt.corbet.deno.net`.

Health check (HTTP):

```
https://careervector-relay-alt.corbet.deno.net/health
```

## Source layout

| File | Runtime | Purpose |
|------|---------|---------|
| `src/index.ts` | **Deno Deploy** (canonical) | `Deno.serve` + `Deno.upgradeWebSocket` — no npm deps |
| `src/index.node.ts` | Node.js | TypeScript source for local Node testing; uses the `ws` package |
| `src/index.node.js` | Node.js | Plain-JS version of the Node runtime (no build step) |

The Deno version is the deployed artifact. The Node versions are retained as a fallback for local debugging without Deno installed.

## Local development

### With Deno (recommended)

```bash
# Install Deno: https://deno.land
curl -fsSL https://deno.land/install.sh | sh

# Run with auto-reload
deno task dev

# Run behavior tests against a running relay
deno task test
```

### With Node fallback

```bash
npm install
npm run dev
```

## Tests

| File | Runner | Notes |
|------|--------|-------|
| `test/relay.deno.test.ts` | `deno test` | Preferred |
| `test/relay.test.ts` | `bun test` | Node-relay harness using Bun for assertions |

Run against a deployed instance:

```bash
RELAY_URL=wss://careervector-relay-alt.corbet.deno.net \
  deno test --allow-net test/relay.deno.test.ts
```

## Deploying your own

Generate a Deno Deploy token at https://dash.deno.com/account#access-tokens, then:

```bash
DENO_DEPLOY_TOKEN=<your-token> deployctl deploy \
  --project=<your-project-name> \
  --prod \
  src/index.ts
```

Install `deployctl` if needed:

```bash
deno install -gArf jsr:@deno/deployctl
```
