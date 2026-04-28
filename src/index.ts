/**
 * CareerVector alt-relay — stateless WebSocket fan-out relay.
 *
 * Drop-in failover for the Cloudflare Durable Object relay (apps/realtime).
 * Same wire protocol: binary frames are fan-out verbatim to every other socket
 * in the same workspace group. No state, no parsing, no persistence.
 *
 * Endpoint: GET /ws/<workspaceId>?userId=<id>  (WebSocket upgrade)
 * Health:   GET /health
 *
 * All frame types (MSG_SYNC=0, MSG_AWARENESS=1, MSG_P2P_SIGNAL=200, etc.)
 * are relayed without inspection — identical to the DO thin-relay mode.
 *
 * Uses Bun.serve's native WebSocket API. Each connected socket is keyed by
 * workspaceId; fan-out iterates only the sockets in the same room.
 */

/// <reference types="bun-types" />

import type { ServerWebSocket } from 'bun';

const PORT = Number(process.env.PORT ?? 8787);

// Context attached to each WebSocket via Bun.serve's typed data.
interface SocketData {
	wsId: string;
	userId: string;
}

// Room registry: workspaceId → set of live sockets.
const rooms = new Map<string, Set<ServerWebSocket<SocketData>>>();

function joinRoom(ws: ServerWebSocket<SocketData>): void {
	const { wsId } = ws.data;
	let room = rooms.get(wsId);
	if (!room) {
		room = new Set();
		rooms.set(wsId, room);
	}
	room.add(ws);
}

function leaveRoom(ws: ServerWebSocket<SocketData>): void {
	const { wsId } = ws.data;
	const room = rooms.get(wsId);
	if (!room) return;
	room.delete(ws);
	if (room.size === 0) rooms.delete(wsId);
}

function fanOut(sender: ServerWebSocket<SocketData>, data: ArrayBuffer | Uint8Array | Buffer): void {
	const room = rooms.get(sender.data.wsId);
	if (!room) return;
	for (const peer of room) {
		if (peer === sender) continue;
		try {
			peer.send(data);
		} catch {
			// Stale socket — evict; it will also fire close/error independently.
			room.delete(peer);
		}
	}
}

const server = Bun.serve<SocketData>({
	port: PORT,

	fetch(req, srv) {
		const url = new URL(req.url);

		// Health endpoint.
		if (url.pathname === '/health') {
			const totalConns = [...rooms.values()].reduce((n, r) => n + r.size, 0);
			return Response.json({
				status: 'ok',
				rooms: rooms.size,
				connections: totalConns,
				ts: Date.now(),
			});
		}

		// WebSocket upgrade: /ws/<workspaceId>
		const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
		if (wsMatch) {
			const wsId = wsMatch[1];
			if (!wsId || wsId.length < 4 || wsId.length > 64) {
				return new Response('Invalid workspace ID', { status: 400 });
			}
			const userId =
				url.searchParams.get('userId') ??
				`anon_${crypto.randomUUID().slice(0, 8)}`;

			const upgraded = srv.upgrade(req, { data: { wsId, userId } });
			if (!upgraded) return new Response('WebSocket upgrade failed', { status: 500 });
			// On success Bun handles the 101 response; return undefined to signal that.
			return undefined as unknown as Response;
		}

		return new Response(
			'CareerVector alt-relay\n\nEndpoints:\n  /ws/<workspaceId>  WebSocket\n  /health            Health check\n',
			{ headers: { 'Content-Type': 'text/plain' } },
		);
	},

	websocket: {
		// Disable per-message compression — Yjs frames are already compact
		// binary; the latency cost of deflate outweighs the savings.
		perMessageDeflate: false,

		open(ws) {
			joinRoom(ws);
		},

		message(ws, message) {
			// The Yjs sync protocol is binary-only; string frames are ignored
			// (same behaviour as the DO in thin-relay mode).
			if (typeof message === 'string') return;
			fanOut(ws, message);
		},

		close(ws) {
			leaveRoom(ws);
		},

		error(ws, _err) {
			leaveRoom(ws);
		},
	},
});

console.log(`[relay-alt] listening on port ${server.port}`);
