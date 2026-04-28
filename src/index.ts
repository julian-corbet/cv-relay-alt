/**
 * CareerVector alt-relay — stateless WebSocket fan-out relay.
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
 * Uses Node.js http + the 'ws' package for WebSocket handling so Koyeb's
 * Node.js buildpack can auto-detect and deploy without a custom Dockerfile.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);

// Room registry: workspaceId → set of live sockets.
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

function fanOut(wsId: string, sender: WebSocket, data: Buffer): void {
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

// HTTP server for health check + WS upgrade handling.
const httpServer = http.createServer((req, res) => {
	if (req.url === '/health') {
		const totalConns = [...rooms.values()].reduce((n, r) => n + r.size, 0);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, connections: totalConns, ts: Date.now() }));
		return;
	}
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('CareerVector alt-relay\n\nEndpoints:\n  /ws/<workspaceId>  WebSocket\n  /health            Health check\n');
});

// WebSocket server — only handles paths matching /ws/<workspaceId>.
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
	const rawUrl = req.url ?? '/';
	const url = new URL(rawUrl, 'http://localhost');
	const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
	if (!wsMatch) {
		socket.destroy();
		return;
	}
	const wsId = wsMatch[1];
	if (!wsId || wsId.length < 4 || wsId.length > 64) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit('connection', ws, req, wsId);
	});
});

wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, wsId: string) => {
	joinRoom(wsId, ws);

	ws.on('message', (data: Buffer, isBinary: boolean) => {
		// Only binary frames are relayed — Yjs protocol is binary-only.
		// String frames are dropped (same as DO thin-relay mode).
		if (!isBinary) return;
		fanOut(wsId, ws, data);
	});

	ws.on('close', () => leaveRoom(wsId, ws));
	ws.on('error', () => leaveRoom(wsId, ws));
});

httpServer.listen(PORT, () => {
	console.log(`[relay-alt] listening on port ${PORT}`);
});
