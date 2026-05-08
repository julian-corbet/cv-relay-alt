/**
 * CareerVector alt-relay — Deno Deploy runtime.
 *
 * Drop-in failover for the Cloudflare Durable Object relay (apps/realtime).
 * Same wire protocol: binary frames are broadcast verbatim to every other
 * socket in the same workspace group. No state, no parsing, no persistence.
 *
 * Endpoint: GET /ws/<workspaceId>?userId=<id>  (WebSocket upgrade)
 * Health:   GET /health
 *
 * All frame types (MSG_SYNC=0, MSG_AWARENESS=1, MSG_P2P_SIGNAL=200, etc.)
 * are relayed without inspection — identical to the DO thin-relay mode.
 *
 * Runtime: Deno Deploy (Deno.serve + Deno.upgradeWebSocket — no npm deps).
 * The Node.js fallback (for local testing) is in src/index.node.ts.
 */

// Room registry: workspaceId → set of live WebSocket connections.
const rooms = new Map<string, Set<WebSocket>>();

function joinRoom(wsId: string, ws: WebSocket): void {
	let room = rooms.get(wsId);
	if (!room) {
		room = new Set();
		rooms.set(wsId, room);
	}
	room.add(ws);
}

function leaveRoom(wsId: string, ws: WebSocket): void {
	const room = rooms.get(wsId);
	if (!room) return;
	room.delete(ws);
	if (room.size === 0) rooms.delete(wsId);
}

function fanOut(wsId: string, sender: WebSocket, data: ArrayBufferLike): void {
	const room = rooms.get(wsId);
	if (!room) return;
	for (const peer of room) {
		if (peer === sender) continue;
		if (peer.readyState !== WebSocket.OPEN) {
			room.delete(peer);
			continue;
		}
		try {
			peer.send(data);
		} catch {
			room.delete(peer);
		}
	}
}

function handleWebSocket(wsId: string, ws: WebSocket): void {
	joinRoom(wsId, ws);

	ws.addEventListener("message", (ev) => {
		// Only binary frames are relayed — Yjs protocol is binary-only.
		// String frames are dropped (same as DO thin-relay mode).
		if (!(ev.data instanceof ArrayBuffer)) return;
		fanOut(wsId, ws, ev.data);
	});

	ws.addEventListener("close", () => leaveRoom(wsId, ws));
	ws.addEventListener("error", () => leaveRoom(wsId, ws));
}

function handleHealth(): Response {
	const totalConns = [...rooms.values()].reduce((n, r) => n + r.size, 0);
	return Response.json({ status: "ok", rooms: rooms.size, connections: totalConns, ts: Date.now() });
}

function handleRoot(): Response {
	return new Response(
		"CareerVector alt-relay\n\nEndpoints:\n  /ws/<workspaceId>  WebSocket\n  /health            Health check\n",
		{ headers: { "Content-Type": "text/plain" } },
	);
}

Deno.serve((req: Request): Response => {
	const url = new URL(req.url);

	// Health check.
	if (req.method === "GET" && url.pathname === "/health") {
		return handleHealth();
	}

	// WebSocket upgrade — only /ws/<workspaceId>.
	const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
	if (wsMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
		const wsId = wsMatch[1];

		// Basic workspace ID validation — same bounds as the Node version.
		if (!wsId || wsId.length < 4 || wsId.length > 64) {
			return new Response("Bad Request: invalid workspace ID", { status: 400 });
		}

		const { socket, response } = Deno.upgradeWebSocket(req);
		handleWebSocket(wsId, socket);
		return response;
	}

	// Default root response.
	return handleRoot();
});
