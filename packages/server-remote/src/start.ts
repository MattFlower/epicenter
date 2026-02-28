/**
 * Remote server entry point.
 *
 * Starts the Epicenter remote server — the coordination server that provides:
 * - Sync relay (primary) — all devices sync through the remote server
 * - AI streaming — all providers via SSE
 * - AI proxy — env var API keys, never leave the remote server
 * - Better Auth — session-based authentication
 *
 * Usage:
 *   bun packages/server-remote/src/start.ts
 *   PORT=4000 bun packages/server-remote/src/start.ts
 */

import { createRemoteServer } from './remote';

const server = createRemoteServer({
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

const { port } = server.start();

console.log(`Epicenter REMOTE server running on http://localhost:${port}`);
console.log(`  Sync:    ws://localhost:${port}/rooms/{room}`);
console.log(`  AI:      POST http://localhost:${port}/ai/chat`);

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});
