/**
 * Behavior tests for the CareerVector alt-relay — Deno test runner.
 *
 * Run against a live relay instance. The relay URL is read from:
 *   RELAY_URL env var (default: ws://localhost:8787)
 *
 * Usage:
 *   # Against local Deno server:
 *   RELAY_URL=ws://localhost:8787 deno test --allow-net test/relay.deno.test.ts
 *
 *   # Against deployed Deno Deploy instance:
 *   RELAY_URL=wss://careervector-relay-alt.corbet.deno.net deno test --allow-net test/relay.deno.test.ts
 *
 * Test cases:
 *   1. Two clients, same workspace — one sends binary frame, the other receives it verbatim.
 *   2. Three clients, same workspace — mutual fan-out works for all pairs.
 *   3. Two clients in DIFFERENT workspaces — traffic does NOT leak between groups.
 *   4. Client disconnect — remaining clients still work, no resource leak.
 *   5. 100 connection-disconnect cycles — no memory / port exhaustion.
 */

import { assertEquals, assert } from "jsr:@std/assert";

const BASE_URL = (Deno.env.get("RELAY_URL") ?? "ws://localhost:8787").replace(/\/$/, "");
const HTTP_URL = BASE_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");

// Wait for a binary message on a WebSocket. Rejects after timeoutMs.
function waitForBinary(ws: WebSocket, timeoutMs = 3000): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", onMsg);
			reject(new Error(`waitForBinary timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		function onMsg(ev: MessageEvent) {
			if (ev.data instanceof ArrayBuffer) {
				clearTimeout(timer);
				ws.removeEventListener("message", onMsg);
				resolve(ev.data);
			}
		}
		ws.addEventListener("message", onMsg);
	});
}

// Open a WebSocket and wait for the open event.
function openWs(wsId: string, userId = "test"): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${BASE_URL}/ws/${wsId}?userId=${userId}`);
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => resolve(ws));
		ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
	});
}

// Close a WebSocket and wait for it to fully close.
function closeWs(ws: WebSocket): Promise<void> {
	return new Promise((resolve) => {
		if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
		ws.addEventListener("close", () => resolve(), { once: true });
		ws.close();
	});
}

// Short delay helper.
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Unique workspace ID per test to avoid cross-test interference.
let idSeq = 0;
function newWsId() {
	return `test-ws-${Date.now()}-${++idSeq}`;
}

// Verify the relay is reachable before running tests.
async function checkRelayReachable() {
	const res = await fetch(`${HTTP_URL}/health`).catch(() => null);
	if (!res || !res.ok) {
		throw new Error(
			`Relay not reachable at ${HTTP_URL}. Start with: deno run --allow-net src/index.ts`,
		);
	}
}

// -------------------------------------------------------------------------
// Test 1: two clients, same workspace — fan-out
// -------------------------------------------------------------------------
Deno.test("fan-out: two clients in same workspace receive each other's frames verbatim", async () => {
	await checkRelayReachable();
	const wsId = newWsId();
	const [ws1, ws2] = await Promise.all([openWs(wsId, "u1"), openWs(wsId, "u2")]);

	const frame = new Uint8Array([0x00, 0x01, 0x02, 0xAB, 0xCD]);
	const received = waitForBinary(ws2);
	ws1.send(frame);

	const buf = await received;
	assertEquals(new Uint8Array(buf), frame);

	// ws2 sends back; ws1 should receive it.
	const frame2 = new Uint8Array([0x01, 0xFF]);
	const received2 = waitForBinary(ws1);
	ws2.send(frame2);
	const buf2 = await received2;
	assertEquals(new Uint8Array(buf2), frame2);

	await Promise.all([closeWs(ws1), closeWs(ws2)]);
});

// -------------------------------------------------------------------------
// Test 2: three clients, same workspace — mutual fan-out
// -------------------------------------------------------------------------
Deno.test("three-client fan-out: frame from ws1 reaches ws2 and ws3 but not sender", async () => {
	await checkRelayReachable();
	const wsId = newWsId();
	const [ws1, ws2, ws3] = await Promise.all([
		openWs(wsId, "u1"),
		openWs(wsId, "u2"),
		openWs(wsId, "u3"),
	]);

	const frame = new Uint8Array([0xAA, 0xBB, 0xCC]);
	const [r2, r3] = [waitForBinary(ws2), waitForBinary(ws3)];

	ws1.send(frame);

	const [b2, b3] = await Promise.all([r2, r3]);
	assertEquals(new Uint8Array(b2), frame);
	assertEquals(new Uint8Array(b3), frame);

	// Verify sender (ws1) does NOT receive its own frame.
	let selfReceived = false;
	ws1.addEventListener("message", () => { selfReceived = true; });
	await delay(200);
	assertEquals(selfReceived, false);

	await Promise.all([closeWs(ws1), closeWs(ws2), closeWs(ws3)]);
});

// -------------------------------------------------------------------------
// Test 3: different workspaces — no cross-group leakage
// -------------------------------------------------------------------------
Deno.test("workspace isolation: frames in workspace A do not reach clients in workspace B", async () => {
	await checkRelayReachable();
	const [wsIdA, wsIdB] = [newWsId(), newWsId()];
	const [wsA1, wsA2, wsB1] = await Promise.all([
		openWs(wsIdA, "a1"),
		openWs(wsIdA, "a2"),
		openWs(wsIdB, "b1"),
	]);

	let leakDetected = false;
	wsB1.addEventListener("message", () => { leakDetected = true; });

	const frame = new Uint8Array([0x11, 0x22, 0x33]);
	const intraReceived = waitForBinary(wsA2);
	wsA1.send(frame);

	// wsA2 should receive the frame within the same workspace.
	await intraReceived;
	// Give a grace window for any erroneous cross-delivery.
	await delay(200);

	assertEquals(leakDetected, false);

	await Promise.all([closeWs(wsA1), closeWs(wsA2), closeWs(wsB1)]);
});

// -------------------------------------------------------------------------
// Test 4: client disconnect — others still work
// -------------------------------------------------------------------------
Deno.test("disconnect resilience: remaining clients still receive frames after one peer disconnects", async () => {
	await checkRelayReachable();
	const wsId = newWsId();
	const [ws1, ws2, ws3] = await Promise.all([
		openWs(wsId, "u1"),
		openWs(wsId, "u2"),
		openWs(wsId, "u3"),
	]);

	// Disconnect ws2.
	await closeWs(ws2);
	await delay(100);

	// ws1 → ws3 should still work.
	const frame = new Uint8Array([0xDE, 0xAD]);
	const received = waitForBinary(ws3);
	ws1.send(frame);
	const buf = await received;
	assertEquals(new Uint8Array(buf), frame);

	await Promise.all([closeWs(ws1), closeWs(ws3)]);
});

// -------------------------------------------------------------------------
// Test 5: 100 connect-disconnect cycles — no resource leak
// -------------------------------------------------------------------------
Deno.test(
	{ name: "connect-disconnect cycles: 100 sequential open/close cycles without exhausting resources", sanitizeResources: false },
	async () => {
		await checkRelayReachable();
		const wsId = newWsId();

		for (let i = 0; i < 100; i++) {
			const ws = await openWs(wsId, `stress_${i}`);
			await closeWs(ws);
		}

		// After all cycles the server should still be alive.
		const healthRes = await fetch(`${HTTP_URL}/health`);
		const health = await healthRes.json() as { rooms: number; connections: number };

		assert(healthRes.ok, "health check must return 200");
		assert(typeof health.connections === "number", "health must report connections count");

		// Re-open a fresh pair to confirm the relay is still functional.
		const wsIdFinal = newWsId();
		const [wsFinal1, wsFinal2] = await Promise.all([
			openWs(wsIdFinal, "check1"),
			openWs(wsIdFinal, "check2"),
		]);
		const frame = new Uint8Array([0x99]);
		const r = waitForBinary(wsFinal2);
		wsFinal1.send(frame);
		const received = await r;
		assertEquals(new Uint8Array(received), frame);
		await Promise.all([closeWs(wsFinal1), closeWs(wsFinal2)]);
	},
);
