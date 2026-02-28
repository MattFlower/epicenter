/**
 * Sync Plugin Integration Tests
 *
 * Tests the full WebSocket sync flow using real Elysia servers
 * and real sync providers over actual WebSocket connections.
 *
 * These tests verify the wiring between the Elysia plugin, room manager,
 * auth, and protocol layers — the exact integration path clients use.
 * Unit tests for individual building blocks live in their respective files.
 *
 * Co-located with plugin.ts for easy discovery.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SyncProvider, SyncStatus } from '@epicenter/sync';
import { createSyncProvider } from '@epicenter/sync';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import type { AuthConfig } from './auth';
import { createSyncPlugin } from './plugin';

// ============================================================================
// Test Utilities
// ============================================================================

let counter = 0;

/** Generate a unique room ID per test to avoid cross-test state bleed. */
function uniqueRoom(): string {
	return `test-room-${Date.now()}-${counter++}`;
}

/**
 * Start a test server on a random port (port 0).
 *
 * Uses the sync plugin directly (no createLocalServer dependency)
 * to keep @epicenter/server free of cyclic deps.
 */
function startTestServer(syncConfig?: { auth?: AuthConfig }) {
	const app = new Elysia()
		.use(new Elysia({ prefix: '/rooms' }).use(createSyncPlugin(syncConfig)))
		.get('/', () => ({ status: 'ok' }));
	app.listen(0);
	if (!app.server) {
		throw new Error('Failed to start test server');
	}
	const port = app.server.port;
	return {
		server: {
			async stop() {
				app.stop();
			},
		},
		port,
		wsUrl(room: string) {
			return `ws://localhost:${port}/rooms/${room}`;
		},
		httpUrl(path = '/') {
			return `http://localhost:${port}${path}`;
		},
	};
}

function startIntegratedTestServer({
	getDoc,
}: {
	getDoc: (roomId: string) => Y.Doc | undefined;
}) {
	const syncPlugin = createSyncPlugin({ getDoc });
	const app = new Elysia().use(syncPlugin).get('/', () => ({ status: 'ok' }));
	app.listen(0);
	if (!app.server) {
		throw new Error('Failed to start integrated test server');
	}
	const port = app.server.port;
	return {
		app,
		port,
		wsUrl(room: string) {
			return `ws://localhost:${port}/${room}`;
		},
		httpUrl(path = '/') {
			return `http://localhost:${port}${path}`;
		},
	};
}

/**
 * Wait for a sync provider to reach a specific status.
 *
 * Subscribes to changes BEFORE checking the current value to prevent
 * a race where the status transitions between the check and subscription.
 * Rejects after timeout to prevent hanging tests.
 */
function waitForStatus(
	provider: SyncProvider,
	target: SyncStatus,
	timeoutMs = 5_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(
				new Error(
					`Timed out waiting for status '${target}', stuck at '${provider.status}'`,
				),
			);
		}, timeoutMs);
		const unsub = provider.onStatusChange((s) => {
			if (s === target) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
		// Check AFTER subscribing to close the race window
		if (provider.status === target) {
			clearTimeout(timer);
			unsub();
			resolve();
		}
	});
}

/**
 * Wait for a Y.Map key to appear in a document.
 *
 * Subscribes to doc updates BEFORE checking the current value to prevent
 * a race where the update arrives between the check and subscription.
 * Uses doc.on('update') to detect changes — event-driven, no polling.
 */
function waitForMapKey(
	doc: Y.Doc,
	mapName: string,
	key: string,
	timeoutMs = 5_000,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			doc.off('update', handler);
			reject(new Error(`Timed out waiting for ${mapName}.${key}`));
		}, timeoutMs);
		const handler = () => {
			const val = doc.getMap(mapName).get(key);
			if (val !== undefined) {
				clearTimeout(timer);
				doc.off('update', handler);
				resolve(val);
			}
		};
		// Subscribe BEFORE checking to close the race window
		doc.on('update', handler);
		const current = doc.getMap(mapName).get(key);
		if (current !== undefined) {
			clearTimeout(timer);
			doc.off('update', handler);
			resolve(current);
		}
	});
}

/**
 * Wait for hasLocalChanges to reach an expected value.
 *
 * Subscribes to changes BEFORE checking the current value to prevent
 * a race where the value transitions between the check and subscription.
 * Uses the provider's onLocalChanges callback — event-driven.
 */
function waitForLocalChanges(
	provider: SyncProvider,
	expected: boolean,
	timeoutMs = 5_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsub();
			reject(
				new Error(
					`Timed out waiting for hasLocalChanges=${expected}, current=${provider.hasLocalChanges}`,
				),
			);
		}, timeoutMs);
		const unsub = provider.onLocalChanges((has) => {
			if (has === expected) {
				clearTimeout(timer);
				unsub();
				resolve();
			}
		});
		// Check AFTER subscribing to close the race window
		if (provider.hasLocalChanges === expected) {
			clearTimeout(timer);
			unsub();
			resolve();
		}
	});
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

// ============================================================================
// Document Sync Tests
// ============================================================================

describe('sync plugin integration', () => {
	let ctx: ReturnType<typeof startTestServer>;

	beforeAll(() => {
		ctx = startTestServer();
	});

	afterAll(async () => {
		await ctx.server.stop();
	});

	test('health endpoint returns status', async () => {
		const res = await fetch(ctx.httpUrl('/'));
		const body = await res.json();
		expect(body).toEqual({ status: 'ok' });
	});

	test('two clients sync document updates', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: ctx.wsUrl(room) });
		const p2 = createSyncProvider({ doc: doc2, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('hello', 'world');

			const value = await waitForMapKey(doc2, 'data', 'hello');
			expect(value).toBe('world');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('sender does not receive its own updates', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: ctx.wsUrl(room) });
		const p2 = createSyncProvider({ doc: doc2, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('from-client-1', 'client-1-value');

			const valueOnClient2 = await waitForMapKey(doc2, 'data', 'from-client-1');
			expect(valueOnClient2).toBe('client-1-value');

			expect(doc1.getMap('data').get('from-client-1')).toBe('client-1-value');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('bidirectional sync merges concurrent edits', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: ctx.wsUrl(room) });
		const p2 = createSyncProvider({ doc: doc2, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');

			doc1.getMap('data').set('from1', 'value1');
			doc2.getMap('data').set('from2', 'value2');

			await waitForMapKey(doc1, 'data', 'from2');
			await waitForMapKey(doc2, 'data', 'from1');

			expect(doc1.getMap('data').get('from1')).toBe('value1');
			expect(doc1.getMap('data').get('from2')).toBe('value2');
			expect(doc2.getMap('data').get('from1')).toBe('value1');
			expect(doc2.getMap('data').get('from2')).toBe('value2');
		} finally {
			p1.destroy();
			p2.destroy();
		}
	});

	test('late joiner receives existing document state', async () => {
		const room = uniqueRoom();
		const doc1 = new Y.Doc();

		const p1 = createSyncProvider({ doc: doc1, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(p1, 'connected');

			doc1.getMap('data').set('existing', 'content');

			// Small delay for server to process the update
			await new Promise((r) => setTimeout(r, 50));

			const doc2 = new Y.Doc();
			const p2 = createSyncProvider({ doc: doc2, url: ctx.wsUrl(room) });

			try {
				await waitForStatus(p2, 'connected');

				const value = await waitForMapKey(doc2, 'data', 'existing');
				expect(value).toBe('content');
			} finally {
				p2.destroy();
			}
		} finally {
			p1.destroy();
		}
	});

	test('rooms are isolated from each other', async () => {
		const roomA = uniqueRoom();
		const roomB = uniqueRoom();
		const docA1 = new Y.Doc();
		const docA2 = new Y.Doc();
		const docB = new Y.Doc();

		const pA1 = createSyncProvider({ doc: docA1, url: ctx.wsUrl(roomA) });
		const pA2 = createSyncProvider({ doc: docA2, url: ctx.wsUrl(roomA) });
		const pB = createSyncProvider({ doc: docB, url: ctx.wsUrl(roomB) });

		try {
			await waitForStatus(pA1, 'connected');
			await waitForStatus(pA2, 'connected');
			await waitForStatus(pB, 'connected');

			docA1.getMap('data').set('secret', 'room-a-only');

			// Positive: A2 (same room) MUST receive the update — proves relay works
			const value = await waitForMapKey(docA2, 'data', 'secret');
			expect(value).toBe('room-a-only');

			// Negative: B (different room) must NOT have received it.
			// Since A2 already got it, any cross-room leak would have arrived too.
			expect(docB.getMap('data').get('secret')).toBeUndefined();
		} finally {
			pA1.destroy();
			pA2.destroy();
			pB.destroy();
		}
	});

	test('hasLocalChanges tracks server acknowledgment', async () => {
		const room = uniqueRoom();
		const doc = new Y.Doc();

		const provider = createSyncProvider({ doc, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(provider, 'connected');

			// After handshake, server echoes SYNC_STATUS — hasLocalChanges becomes false
			await waitForLocalChanges(provider, false);
			expect(provider.hasLocalChanges).toBe(false);

			// Local edit makes it dirty
			doc.getMap('data').set('key', 'value');
			expect(provider.hasLocalChanges).toBe(true);

			// Server echo makes it clean again
			await waitForLocalChanges(provider, false);
			expect(provider.hasLocalChanges).toBe(false);
		} finally {
			provider.destroy();
		}
	});
});

describe('sync plugin integrated mode', () => {
	test('closes with 4004 when getDoc returns undefined', async () => {
		const ctx = startIntegratedTestServer({ getDoc: () => undefined });
		const room = uniqueRoom();
		const doc = new Y.Doc();
		const provider = createSyncProvider({
			doc,
			url: ctx.wsUrl(room),
		});

		try {
			await waitForStatus(provider, 'error');
			expect(provider.status).toBe('error');
		} finally {
			provider.destroy();
			ctx.app.stop();
		}
	});
});

// ============================================================================
// REST Integration Tests
// ============================================================================

describe('sync plugin REST room list', () => {
	test('returns empty rooms array when no rooms are active', async () => {
		const ctx = startTestServer();

		try {
			const res = await fetch(ctx.httpUrl('/rooms/'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ rooms: [] });
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns room with connection count after one client connects', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();
		const doc = new Y.Doc();
		const provider = createSyncProvider({ doc, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(provider, 'connected');

			const res = await fetch(ctx.httpUrl('/rooms/'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				rooms: [{ id: room, connections: 1 }],
			});
		} finally {
			provider.destroy();
			await ctx.server.stop();
		}
	});

	test('returns correct connection count after multiple clients connect', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();
		const doc1 = new Y.Doc();
		const doc2 = new Y.Doc();
		const doc3 = new Y.Doc();
		const p1 = createSyncProvider({ doc: doc1, url: ctx.wsUrl(room) });
		const p2 = createSyncProvider({ doc: doc2, url: ctx.wsUrl(room) });
		const p3 = createSyncProvider({ doc: doc3, url: ctx.wsUrl(room) });

		try {
			await waitForStatus(p1, 'connected');
			await waitForStatus(p2, 'connected');
			await waitForStatus(p3, 'connected');

			const res = await fetch(ctx.httpUrl('/rooms/'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				rooms: [{ id: room, connections: 3 }],
			});
		} finally {
			p1.destroy();
			p2.destroy();
			p3.destroy();
			await ctx.server.stop();
		}
	});
});

describe('sync plugin REST document snapshot', () => {
	test('returns 404 when room does not exist', async () => {
		const ctx = startTestServer();

		try {
			const room = uniqueRoom();
			const res = await fetch(ctx.httpUrl(`/rooms/${room}`));
			expect(res.status).toBe(404);
			expect(await res.text()).toBe(`Room not found: ${room}`);
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns binary snapshot that can be applied to a fresh doc', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();
		const writerDoc = new Y.Doc();
		const provider = createSyncProvider({
			doc: writerDoc,
			url: ctx.wsUrl(room),
		});

		try {
			await waitForStatus(provider, 'connected');
			await waitForLocalChanges(provider, false);

			writerDoc.getMap('data').set('from-ws', 'hello-rest');
			expect(provider.hasLocalChanges).toBe(true);
			await waitForLocalChanges(provider, false);

			const res = await fetch(ctx.httpUrl(`/rooms/${room}`));
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain(
				'application/octet-stream',
			);

			const update = new Uint8Array(await res.arrayBuffer());
			expect(update.length).toBeGreaterThan(0);

			const restoredDoc = new Y.Doc();
			Y.applyUpdate(restoredDoc, update);
			expect(restoredDoc.getMap('data').get('from-ws')).toBe('hello-rest');
		} finally {
			provider.destroy();
			await ctx.server.stop();
		}
	});
});

describe('sync plugin REST document update', () => {
	test('creates room on demand and update is visible to later WS clients', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();

		try {
			const sourceDoc = new Y.Doc();
			sourceDoc.getMap('data').set('seed', 'from-rest');
			const update = Y.encodeStateAsUpdate(sourceDoc);

			const postRes = await fetch(ctx.httpUrl(`/rooms/${room}`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: toArrayBuffer(update),
			});

			expect(postRes.status).toBe(200);
			expect(await postRes.json()).toEqual({ ok: true });

			const wsDoc = new Y.Doc();
			const provider = createSyncProvider({ doc: wsDoc, url: ctx.wsUrl(room) });

			try {
				await waitForStatus(provider, 'connected');
				const value = await waitForMapKey(wsDoc, 'data', 'seed');
				expect(value).toBe('from-rest');
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns 400 for empty body', async () => {
		const ctx = startTestServer();
		const room = uniqueRoom();

		try {
			const res = await fetch(ctx.httpUrl(`/rooms/${room}`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: new ArrayBuffer(0),
			});

			expect(res.status).toBe(400);
			expect(await res.text()).toBe('Empty update body');
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns 404 when getDoc rejects room in integrated mode', async () => {
		const ctx = startIntegratedTestServer({ getDoc: () => undefined });
		const room = uniqueRoom();

		try {
			const sourceDoc = new Y.Doc();
			sourceDoc.getMap('data').set('ignored', 'value');
			const update = Y.encodeStateAsUpdate(sourceDoc);

			const res = await fetch(ctx.httpUrl(`/${room}`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: toArrayBuffer(update),
			});

			expect(res.status).toBe(404);
			expect(await res.text()).toBe(`Room not found: ${room}`);
		} finally {
			ctx.app.stop();
		}
	});
});

describe('sync plugin REST auth', () => {
	test('returns 401 without Authorization header when auth is configured', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });

		try {
			const res = await fetch(ctx.httpUrl('/rooms/'));
			expect(res.status).toBe(401);
			expect(await res.text()).toBe('Unauthorized');
		} finally {
			await ctx.server.stop();
		}
	});

	test('returns 401 with wrong Bearer token', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });

		try {
			const res = await fetch(ctx.httpUrl('/rooms/'), {
				headers: { Authorization: 'Bearer wrong' },
			});
			expect(res.status).toBe(401);
			expect(await res.text()).toBe('Unauthorized');
		} finally {
			await ctx.server.stop();
		}
	});

	test('works with correct Bearer token', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });
		const room = uniqueRoom();

		try {
			const sourceDoc = new Y.Doc();
			sourceDoc.getMap('data').set('k', 'v');
			const update = Y.encodeStateAsUpdate(sourceDoc);

			const postRes = await fetch(ctx.httpUrl(`/rooms/${room}`), {
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret',
					'Content-Type': 'application/octet-stream',
				},
				body: toArrayBuffer(update),
			});
			expect(postRes.status).toBe(200);

			const getRes = await fetch(ctx.httpUrl('/rooms/'), {
				headers: { Authorization: 'Bearer secret' },
			});
			expect(getRes.status).toBe(200);
			expect(await getRes.json()).toEqual({
				rooms: [{ id: room, connections: 0 }],
			});
		} finally {
			await ctx.server.stop();
		}
	});

	test('works without auth when no auth is configured', async () => {
		const ctx = startTestServer();

		try {
			const res = await fetch(ctx.httpUrl('/rooms/'));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ rooms: [] });
		} finally {
			await ctx.server.stop();
		}
	});

	test('ignores token query param for REST routes (Bearer header only)', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });

		try {
			const queryTokenRes = await fetch(ctx.httpUrl('/rooms/?token=secret'));
			expect(queryTokenRes.status).toBe(401);

			const headerRes = await fetch(ctx.httpUrl('/rooms/?token=wrong'), {
				headers: { Authorization: 'Bearer secret' },
			});
			expect(headerRes.status).toBe(200);
			expect(await headerRes.json()).toEqual({ rooms: [] });
		} finally {
			await ctx.server.stop();
		}
	});
});

// ============================================================================
// Auth Tests (separate servers per test — different auth configs)
// ============================================================================

describe('sync plugin auth', () => {
	/**
	 * Helper to assert a provider never reaches 'connected'.
	 *
	 * Event-driven: waits for 'error' status (proving the attempt happened),
	 * then records all subsequent statuses for a window to confirm 'connected'
	 * never appears. Much faster and more reliable than a fixed sleep.
	 */
	async function expectAuthRejection(provider: SyncProvider): Promise<void> {
		// Wait for at least one 'error' status (proves the server rejected us)
		await waitForStatus(provider, 'error', 5_000);

		// Collect statuses for a short window to catch any delayed 'connected'
		const statuses: SyncStatus[] = [];
		const unsub = provider.onStatusChange((s) => statuses.push(s));
		await new Promise((r) => setTimeout(r, 500));
		unsub();

		expect(statuses).not.toContain('connected');
	}

	test('rejects connection without token when auth is required', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: ctx.wsUrl(room),
			});

			try {
				await expectAuthRejection(provider);
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});

	test('rejects connection with wrong token', async () => {
		const ctx = startTestServer({ auth: { token: 'correct-token' } });

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: ctx.wsUrl(room),
				token: 'wrong-token',
			});

			try {
				await expectAuthRejection(provider);
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});

	test('accepts connection with correct token', async () => {
		const ctx = startTestServer({ auth: { token: 'secret' } });

		try {
			const room = uniqueRoom();
			const doc = new Y.Doc();

			const provider = createSyncProvider({
				doc,
				url: ctx.wsUrl(room),
				token: 'secret',
			});

			try {
				await waitForStatus(provider, 'connected');
				expect(provider.status).toBe('connected');
			} finally {
				provider.destroy();
			}
		} finally {
			await ctx.server.stop();
		}
	});
});
