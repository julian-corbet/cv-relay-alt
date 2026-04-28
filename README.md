# relay-alt

Stateless WebSocket fan-out relay for CareerVector. Serves as a vendor-independent
failover for the Cloudflare Durable Object relay when the DO is quota-exhausted or
unavailable.

Implements the same wire protocol as `apps/realtime` in thin-relay mode: binary
frames are broadcast verbatim to every other socket in the same workspace group.
No state, no parsing, no persistence.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws/<workspaceId>?userId=<id>` | `GET` (WS upgrade) | Join a workspace relay group |
| `/health` | `GET` | Health check; returns `{ status, rooms, connections, ts }` |

## Architecture notes

- Pure in-process fan-out via a `Map<wsId, Set<ServerWebSocket>>`.
- Binary frames only — string frames are dropped (Yjs protocol is binary).
- No authentication, no workspace validation (same as the DO thin-relay).
- Stateless: no Yjs doc, no snapshots, no alarms.

## Deploy URL (staging)

**`wss://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app/ws/<wsId>`**

HTTP health: `https://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app/health`

## Local development

```bash
# Install Bun (https://bun.sh) if not already installed:
curl -fsSL https://bun.sh/install | bash

# Run in dev mode (auto-restarts on file change):
bun run dev

# Run behavior tests (relay must be running):
bun test
```

## Docker build

```bash
docker build -t cv-relay-alt .
docker run -p 8787:8787 cv-relay-alt
```

## Koyeb deployment

The service is deployed on Koyeb using Docker (Dockerfile in this directory).

**First deploy (done once):**

```bash
export KOYEB_TOKEN=<token from secrets/koyeb.md>

# Create app + service pointing at the GitHub repo, relay-alt Dockerfile.
koyeb app create careervector-relay-alt
koyeb service create relay \
  --app careervector-relay-alt \
  --git github.com/julian-corbet/careervector \
  --git-branch v2-sveltekit \
  --git-build-context v2-app/apps/relay-alt \
  --git-dockerfile v2-app/apps/relay-alt/Dockerfile \
  --port 8787:http \
  --health-check-path /health \
  --regions fra \
  --instance-type free
```

**Redeploy after code changes:**

```bash
koyeb service redeploy relay --app careervector-relay-alt
```

**Check deploy status:**

```bash
koyeb service describe relay --app careervector-relay-alt
```

## Post-deploy verification

1. Health check:
   ```bash
   curl https://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app/health
   ```

2. Two-client smoke test:
   ```bash
   # terminal 1 — listen
   wscat -c "wss://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app/ws/smoke-test"
   # terminal 2 — send (after terminal 1 is connected)
   wscat -c "wss://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app/ws/smoke-test"
   ```

3. Run behavior tests against the deployed instance:
   ```bash
   RELAY_URL=wss://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app bun test
   ```

## Client failover configuration

Set `PUBLIC_ALT_RELAY_URL` in the web app's environment to activate failover:

```
# wrangler.toml [env.staging.vars]
PUBLIC_ALT_RELAY_URL = "wss://careervector-relay-alt-corbet-consulting-992944d3.koyeb.app"
```

The failover logic lives in `apps/web/src/lib/realtime/connection-impl.ts`.
