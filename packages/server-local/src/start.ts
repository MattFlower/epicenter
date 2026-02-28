/**
 * Local server entry point.
 *
 * Starts the Epicenter local server — the per-device sidecar that provides:
 * - Sync relay (local) — fast sub-ms WebSocket sync between webview and Y.Doc
 * - Workspace API — RESTful CRUD for workspace tables, extensions, and actions
 *   (pass workspace clients to `createLocalServer` to activate these routes)
 *
 * The local server does NOT handle AI — all AI goes through the remote server.
 *
 * Usage:
 *   bun packages/server-local/src/start.ts
 *   PORT=4000 bun packages/server-local/src/start.ts
 */

import { createLocalServer } from './local';

const server = createLocalServer({
	clients: [],
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

const { port } = server.start();

console.log(`Epicenter LOCAL server running on http://localhost:${port}`);
console.log(`  Sync:    ws://localhost:${port}/rooms/{room}`);
console.log(`  (No AI — all AI goes through the remote server)`);

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});
