import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { listenWithFallback } from '@epicenter/server';
import type { AuthConfig } from '@epicenter/server/sync';
import { createSyncPlugin } from '@epicenter/server/sync';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createRemoteSessionValidator } from './auth/local-auth';
import { createWorkspacePlugin } from './workspace';
import { collectActionPaths } from './workspace/actions';

export type LocalServerConfig = {
	/**
	 * Workspace clients to expose via REST CRUD and action endpoints.
	 *
	 * Pass an empty array for a sync-only relay (no workspace routes).
	 * Non-empty arrays mount table and action endpoints under `/workspaces/{id}`.
	 */
	clients: AnyWorkspaceClient[];

	/**
	 * Preferred port to listen on.
	 *
	 * Falls back to the `PORT` environment variable, then 3913.
	 * If the port is taken, the OS assigns an available one.
	 */
	port?: number;

	/**
	 * Remote server URL for session token validation.
	 *
	 * When provided, the local server validates all requests by checking
	 * the Bearer token against the remote server's `/auth/get-session` endpoint.
	 * Results are cached with a 5-minute TTL.
	 *
	 * Omit for open mode (no auth, development only).
	 */
	remoteUrl?: string;

	/**
	 * CORS allowed origins.
	 *
	 * Default: `['tauri://localhost']` — only the Tauri webview can call the local server.
	 * Add the remote server origin if it needs to reach it directly.
	 */
	allowedOrigins?: string[];

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
 * Create an Elysia plugin for auth guard (if remoteUrl configured).
 *
 * Separated into its own plugin so the type chain is not broken by conditionals.
 */
function createAuthGuardPlugin(remoteUrl?: string) {
	const plugin = new Elysia();
	if (!remoteUrl) return plugin;

	const validateSession = createRemoteSessionValidator({ remoteUrl });
	plugin.onBeforeHandle({ as: 'global' }, async ({ request, status, path }) => {
		if (path === '/') return;

		const authHeader = request.headers.get('authorization');
		if (!authHeader?.startsWith('Bearer ')) {
			return status(401, 'Unauthorized: Bearer token required');
		}

		const token = authHeader.slice(7);
		const result = await validateSession(token);

		if (!result.valid) {
			return status(401, 'Unauthorized: Invalid session token');
		}
	});
	return plugin;
}

/**
 * Create an Epicenter local server.
 *
 * The local server is the middle tier in the three-tier topology: one sidecar
 * process per device (embedded in the Tauri app or run standalone). It sits
 * between the SPA/webview on the same machine and the shared remote server in the cloud.
 *
 *   Remote Server (cloud)
 *   +-----------------------------------------+
 *   |  Auth, AI proxy, AI streaming, Yjs relay |
 *   +-----------------------------------------+
 *          ^  cross-device Yjs sync (Phase 4)
 *          |  AI requests
 *          |
 *   Local Server (this process, one per device)
 *   +-----------------------------------------+
 *   |  - Workspace CRUD (REST + action routes) |
 *   |  - Extensions (filesystem projections)   |
 *   |  - Actions (per-workspace endpoints)     |
 *   |  - Persisted Y.Docs (workspace.yjs file) |
 *   |  - Local Yjs relay (SPA <-> Y.Doc)       |
 *   +-----------------------------------------+
 *          |  sub-ms WebSocket sync (same machine)
 *          v
 *   SPA / WebView (Tauri or browser)
 *
 * What the local server DOES:
 * - Workspace CRUD: read/write workspace configs, tables, and blobs (`/workspaces/*`)
 * - Extensions: filesystem projections exposed as workspace tables
 * - Actions: per-workspace HTTP endpoints generated from the workspace schema
 * - Persisted Y.Docs: each workspace's Y.Doc is loaded from and saved to a
 *   `workspace.yjs` file on disk. This is the authoritative source of truth
 *   for that device.
 * - Local Yjs relay: serves the `/rooms/*` WebSocket endpoint so the SPA's
 *   in-memory Y.Doc stays in sync with the server's persisted Y.Doc on the
 *   same machine (sub-millisecond round-trip).
 *
 * What the local server does NOT do:
 * - AI streaming: the SPA sends AI requests directly to the remote server's `/ai/chat`
 *   endpoint; the local server is not involved.
 * - Auth issuance: sessions and JWT/JWKS are issued exclusively by Better Auth
 *   on the remote server. The local server only validates tokens — it calls the remote server's
 *   `/auth/get-session` endpoint (configured via `remoteUrl`) and caches results
 *   for 5 minutes.
 *
 * Two sync scopes:
 * 1. Local relay (always active): SPA <-> local server on the same machine,
 *    via `/rooms/*` WebSocket. Latency is sub-millisecond.
 * 2. Remote server sync (Phase 4, not yet wired): local server <-> remote server,
 *    enabled by the `--remote` flag. Propagates persisted Y.Doc updates across
 *    devices through the remote server's ephemeral Yjs relay.
 *
 * @example
 * ```typescript
 * // Local server with auth (production)
 * createLocalServer({
 *   clients: [blogClient],
 *   remoteUrl: 'https://remote.example.com',
 *   allowedOrigins: ['tauri://localhost'],
 * }).start();
 *
 * // Minimal local server (development, no auth)
 * createLocalServer({ clients: [] }).start();
 * ```
 */
export function createLocalServer(config: LocalServerConfig) {
	const { clients, sync } = config;

	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	/** Ephemeral Y.Docs for rooms with no pre-registered workspace client. */
	const dynamicDocs = new Map<string, Y.Doc>();

	const allActionPaths = clients.flatMap((client) => {
		if (!client.actions) return [];
		return collectActionPaths(client.actions).map((p) => `${client.id}/${p}`);
	});

	const app = new Elysia()
		.use(
			cors({
				origin: config.allowedOrigins ?? ['tauri://localhost'],
				credentials: true,
				allowedHeaders: ['Content-Type', 'Authorization'],
			}),
		)
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter Sidecar API',
						version: '1.0.0',
						description: 'Sidecar server — local sync relay and workspace API.',
					},
				},
			}),
		)
		.use(createAuthGuardPlugin(config.remoteUrl))
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createSyncPlugin({
					getDoc:
						clients.length > 0
							? (room) => {
									if (workspaces[room]) return workspaces[room].ydoc;

									if (!dynamicDocs.has(room)) {
										dynamicDocs.set(room, new Y.Doc());
									}
									return dynamicDocs.get(room);
								}
							: undefined,
					auth: sync?.auth,
					onRoomCreated: sync?.onRoomCreated,
					onRoomEvicted: sync?.onRoomEvicted,
				}),
			),
		)
		.get('/', () => ({
			name: 'Epicenter Local',
			version: '1.0.0',
			mode: 'local' as const,
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}))
		.use(
			new Elysia({ prefix: '/workspaces' }).use(createWorkspacePlugin(clients)),
		);

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
		 * Stop the HTTP server and destroy all workspace clients.
		 *
		 * Cleans up workspace clients, ephemeral sync documents, and the HTTP listener.
		 */
		async stop() {
			app.stop();
			await Promise.all(clients.map((c) => c.destroy()));
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}

export type LocalApp = ReturnType<typeof createLocalServer>['app'];
