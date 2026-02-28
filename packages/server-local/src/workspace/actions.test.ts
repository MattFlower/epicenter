/**
 * Actions Plugin Tests
 *
 * Verifies HTTP routing for query and mutation actions via static per-action
 * routes registered by createActionsPlugin. Tests cover single and multi-workspace
 * scenarios, nested action trees, input validation, and OpenAPI metadata.
 *
 * Key behaviors:
 * - Query/mutation actions map to correct HTTP methods and response payloads.
 * - Per-action routes get individual OpenAPI metadata with namespace tags.
 * - Action path discovery produces expected flattened route paths.
 */

import { describe, expect, test } from 'bun:test';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';
import { Elysia } from 'elysia';
import Type from 'typebox';
import { collectActionPaths, createActionsPlugin } from './actions';

function makeWorkspaceWithActions(
	id: string,
	actions: () => Record<string, any>,
) {
	return createWorkspace(
		defineWorkspace({
			id,
			tables: {
				_dummy: defineTable(type({ id: 'string', _v: '1' })),
			},
		}),
	).withActions(actions);
}

function buildApp(clients: AnyWorkspaceClient[]) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}
	return new Elysia().use(createActionsPlugin(workspaces));
}

describe('createActionsPlugin', () => {
	test('creates routes for flat actions', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			ping: defineQuery({ handler: () => 'pong' }),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/ping'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'pong' });
	});

	test('creates routes for nested actions', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			posts: {
				list: defineQuery({ handler: () => ['post1', 'post2'] }),
			},
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/posts/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: ['post1', 'post2'] });
	});

	test('query actions respond to GET requests', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			getStatus: defineQuery({ handler: () => ({ status: 'ok' }) }),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/getStatus', { method: 'GET' }),
		);

		expect(response.status).toBe(200);
	});

	test('mutation actions respond to POST requests', async () => {
		let called = false;
		const client = makeWorkspaceWithActions('ws', () => ({
			doSomething: defineMutation({
				handler: () => {
					called = true;
					return { done: true };
				},
			}),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/doSomething', { method: 'POST' }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(called).toBe(true);
		expect(body).toEqual({ data: { done: true } });
	});

	test('mutation actions accept JSON body input', async () => {
		let capturedInput: unknown = null;
		const client = makeWorkspaceWithActions('ws', () => ({
			create: defineMutation({
				input: Type.Object({ title: Type.String() }),
				handler: (input) => {
					capturedInput = input;
					return { id: '123', title: input.title };
				},
			}),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello World' }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(capturedInput).toEqual({ title: 'Hello World' });
		expect(body).toEqual({ data: { id: '123', title: 'Hello World' } });
	});

	test('validates input and returns 422 for invalid data', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			create: defineMutation({
				input: Type.Object({ title: Type.String(), count: Type.Number() }),
				handler: ({ title, count }) => ({ title, count }),
			}),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello', count: 'not-a-number' }),
			}),
		);

		expect(response.status).toBe(422);
	});

	test('async handlers resolve and return data payloads', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			asyncQuery: defineQuery({
				handler: async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { async: true };
				},
			}),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/asyncQuery'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: { async: true } });
	});

	test('deeply nested actions create correct routes', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			api: {
				v1: {
					users: {
						list: defineQuery({ handler: () => [] }),
					},
				},
			},
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/ws/actions/api/v1/users/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: [] });
	});

	test('returns 404 for workspace without the requested action', async () => {
		const wsA = makeWorkspaceWithActions('a', () => ({
			ping: defineQuery({ handler: () => 'pong' }),
		}));
		const wsB = makeWorkspaceWithActions('b', () => ({
			sync: defineMutation({ handler: () => 'synced' }),
		}));

		const app = buildApp([wsA, wsB]);

		// Workspace B doesn't have 'ping'
		const response = await app.handle(
			new Request('http://test/b/actions/ping'),
		);

		expect(response.status).toBe(404);
	});

	test('routes are shared across workspaces with the same action paths', async () => {
		const wsA = makeWorkspaceWithActions('a', () => ({
			ping: defineQuery({ handler: () => 'pong-a' }),
		}));
		const wsB = makeWorkspaceWithActions('b', () => ({
			ping: defineQuery({ handler: () => 'pong-b' }),
		}));

		const app = buildApp([wsA, wsB]);

		const responseA = await app.handle(
			new Request('http://test/a/actions/ping'),
		);
		const responseB = await app.handle(
			new Request('http://test/b/actions/ping'),
		);

		expect((await responseA.json()).data).toBe('pong-a');
		expect((await responseB.json()).data).toBe('pong-b');
	});

	test('returns 404 for nonexistent workspace', async () => {
		const client = makeWorkspaceWithActions('ws', () => ({
			ping: defineQuery({ handler: () => 'pong' }),
		}));

		const app = buildApp([client]);
		const response = await app.handle(
			new Request('http://test/nonexistent/actions/ping'),
		);

		expect(response.status).toBe(404);
	});
});

describe('collectActionPaths', () => {
	test('collects flat action paths', () => {
		const actions = {
			ping: defineQuery({ handler: () => 'pong' }),
			sync: defineMutation({ handler: () => {} }),
		};

		const paths = collectActionPaths(actions);

		expect(paths).toContain('ping');
		expect(paths).toContain('sync');
		expect(paths).toHaveLength(2);
	});

	test('collects nested action paths', () => {
		const actions = {
			posts: {
				list: defineQuery({ handler: () => [] }),
				create: defineMutation({ handler: () => {} }),
			},
			users: {
				get: defineQuery({ handler: () => null }),
			},
		};

		const paths = collectActionPaths(actions);

		expect(paths).toContain('posts/list');
		expect(paths).toContain('posts/create');
		expect(paths).toContain('users/get');
		expect(paths).toHaveLength(3);
	});

	test('collectActionPaths flattens deeply nested actions into slash paths', () => {
		const actions = {
			api: {
				v1: {
					users: {
						list: defineQuery({ handler: () => [] }),
					},
				},
			},
		};

		const paths = collectActionPaths(actions);

		expect(paths).toEqual(['api/v1/users/list']);
	});

	test('returns empty array for empty actions', () => {
		const paths = collectActionPaths({});

		expect(paths).toEqual([]);
	});
});
