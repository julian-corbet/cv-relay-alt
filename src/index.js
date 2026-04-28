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
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT ?? 8787);

// Room registry: workspaceId → Set of live WebSocket sockets.
const rooms = new Map();

function joinRoom(wsId, ws) {
	let room = rooms.get(wsId);
	if (!room) {
		room = new Set();
		rooms.set(wsId, room);
	}
	room.add(ws);
}

function leaveRoom(wsId, ws) {
	const room = rooms.get(wsId);
	if (!room) return;
	room.delete(ws);
	if (room.size === 0) rooms.delete(wsId);
}

function fanOut(wsId, sender, data) {
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

// HTTP server for health check and WS upgrade routing.
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

// WebSocket server — only handles /ws/<workspaceId> paths.
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
	const rawUrl = req.url || '/';
	const url = new URL(rawUrl, 'http://localhost');
	const match = url.pathname.match(/^\/ws\/([^/]+)$/);
	if (!match) {
		socket.destroy();
		return;
	}
	const wsId = match[1];
	if (!wsId || wsId.length < 4 || wsId.length > 64) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit('connection', ws, req, wsId);
	});
});

wss.on('connection', (ws, _req, wsId) => {
	joinRoom(wsId, ws);

	ws.on('message', (data, isBinary) => {
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
