import { openapi } from '@elysiajs/openapi';
import { listenWithFallback } from '@epicenter/server';
import type { AuthConfig } from '@epicenter/server/sync';
import { createSyncPlugin } from '@epicenter/server/sync';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createAIPlugin } from './ai';
import { type AuthPluginConfig, createAuthPlugin } from './auth';
import { createProxyPlugin } from './proxy';

export { DEFAULT_PORT, listenWithFallback } from '@epicenter/server';

export type RemoteServerConfig = {
	/**
	 * Preferred port to listen on.
	 *
	 * Falls back to the `PORT` environment variable, then 3913.
	 * If the port is taken, the OS assigns an available one.
	 */
	port?: number;

	/**
	 * Better Auth configuration.
	 *
	 * When provided, mounts Better Auth at `/auth/*` with session-based
	 * authentication and Bearer token support. Omit for open mode (no auth).
	 */
	auth?: AuthPluginConfig;

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		/** Auth for sync endpoints. Omit for open mode (no auth). */
		auth?: AuthConfig;

		/** Called when a new sync room is created on demand. */
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

		/** Called when an idle sync room is evicted after all clients disconnect. */
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};

/**
 * Create an Epicenter remote server.
 *
 * The remote server is the top tier in the three-tier topology: one cloud/hosted instance
 * shared by all devices. Local sidecar servers (one per device) connect outward
 * to the remote server for cross-device Yjs sync and AI requests.
 *
 *   Remote (cloud, one instance)
 *   +--------------------------------------------------+
 *   |  - Better Auth: sessions, JWT, JWKS              |
 *   |  - AI proxy: API keys in env vars, never leave   |
 *   |  - AI streaming: SSE chat completions            |
 *   |  - Yjs relay: ephemeral Y.Docs, pure WebSocket   |
 *   +--------------------------------------------------+
 *          |  cross-device Yjs sync      |  AI requests
 *          v                             v
 *   Local Server A (Device 1)    Local Server B (Device 2)
 *
 * What the remote server DOES:
 * - Issues and validates sessions via Better Auth (`/auth/*`)
 * - Proxies AI provider API keys so they never leave the remote server (`/proxy/*`)
 * - Streams AI completions from all providers via SSE (`/ai/chat`)
 * - Relays Yjs updates between clients via WebSocket rooms (`/rooms/*`)
 *
 * What the remote server does NOT do:
 * - Workspace CRUD (no configs, tables, or file projections)
 * - Extension or action execution
 * - Persistence of any kind — Y.Docs on the remote server are ephemeral; they are
 *   created on demand when the first client joins a room and destroyed when
 *   the last client leaves. The local server holds the persisted source of truth.
 *
 * Cross-device sync (Phase 4, not yet wired):
 * Local servers will connect to the remote server as Yjs clients (via `--remote` flag),
 * so that edits on Device A propagate to Device B through the remote relay.
 * The remote server itself still holds no durable state; it is a pure relay.
 *
 * @example
 * ```typescript
 * import { Database } from 'bun:sqlite';
 *
 * // Full remote server: auth + proxy + sync + AI
 * createRemoteServer({
 *   auth: {
 *     database: new Database('auth.db'),
 *     secret: 'my-secret',
 *     trustedOrigins: ['tauri://localhost'],
 *   },
 * }).start();
 *
 * // Minimal remote server — no auth (development)
 * createRemoteServer({}).start();
 * ```
 */
export function createRemoteServer(config: RemoteServerConfig) {
	const { sync } = config;

	/** Ephemeral Y.Docs for rooms (remote server is a pure relay, no pre-registered workspaces). */
	const dynamicDocs = new Map<string, Y.Doc>();

	const app = new Elysia()
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter Remote API',
						version: '1.0.0',
						description:
							'Remote server — sync relay, AI streaming, and coordination.',
					},
				},
			}),
		)
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createSyncPlugin({
					getDoc: (room) => {
						if (!dynamicDocs.has(room)) {
							dynamicDocs.set(room, new Y.Doc());
						}
						return dynamicDocs.get(room);
					},
					auth: sync?.auth,
					onRoomCreated: sync?.onRoomCreated,
					onRoomEvicted: sync?.onRoomEvicted,
				}),
			),
		)
		.use(new Elysia({ prefix: '/ai' }).use(createAIPlugin()))
		.get('/', () => ({
			name: 'Epicenter Remote',
			version: '1.0.0',
			mode: 'remote' as const,
		}));

	// Mount Better Auth when configured
	if (config.auth) {
		app.use(createAuthPlugin(config.auth));
	}

	// Mount AI proxy unconditionally — reads API keys from env vars
	app.use(createProxyPlugin());

	const preferredPort =
		config.port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	return {
		app,

		/**
		 * Start listening on the preferred port, falling back to an OS-assigned
		 * port if it's already taken.
		 *
		 * Does not log or install signal handlers — the caller owns those concerns.
		 */
		start() {
			const actualPort = listenWithFallback(app, preferredPort);
			return { ...app.server!, port: actualPort };
		},

		/**
		 * Stop the HTTP server and clean up resources.
		 */
		async stop() {
			app.stop();
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}
