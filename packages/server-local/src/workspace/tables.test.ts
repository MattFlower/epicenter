import { describe, expect, test } from 'bun:test';
import {
	createWorkspace,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';
import { Elysia } from 'elysia';
import { createTablesPlugin } from './tables';

function setup() {
	const client = createWorkspace(
		defineWorkspace({
			id: 'test-workspace',
			tables: {
				posts: defineTable(
					type({
						id: 'string',
						title: 'string',
						content: 'string',
						_v: '1',
					}),
				),
			},
		}),
	);
	const workspaces = { 'test-workspace': client };
	const app = new Elysia().use(createTablesPlugin(workspaces));
	return { client, app };
}

describe('createTablesPlugin', () => {
	test('GET /:workspaceId/tables/:table returns all valid rows (200)', async () => {
		const { client, app } = setup();

		client.tables.posts.set({
			id: 'post-1',
			title: 'First',
			content: 'hello',
			_v: 1,
		});
		client.tables.posts.set({
			id: 'post-2',
			title: 'Second',
			content: 'world',
			_v: 1,
		});

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual([
			{ id: 'post-1', title: 'First', content: 'hello', _v: 1 },
			{ id: 'post-2', title: 'Second', content: 'world', _v: 1 },
		]);
	});

	test('GET /:workspaceId/tables/:table/:id returns row when found (200)', async () => {
		const { client, app } = setup();

		client.tables.posts.set({
			id: 'post-1',
			title: 'Found',
			content: 'row',
			_v: 1,
		});

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/post-1'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			status: 'valid',
			row: { id: 'post-1', title: 'Found', content: 'row', _v: 1 },
		});
	});

	test('GET /:workspaceId/tables/:table/:id returns 404 for not_found', async () => {
		const { app } = setup();

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/missing-id'),
		);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			status: 'not_found',
			id: 'missing-id',
		});
	});

	test('GET /:workspaceId/tables/:table/:id returns 422 for invalid row', async () => {
		const { client, app } = setup();

		client.tables.posts.set({ id: 'broken', title: 'Broken' } as unknown as {
			id: string;
			title: string;
			content: string;
			_v: 1;
		});

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/broken'),
		);
		const body = await response.json();

		expect(response.status).toBe(422);
		expect(body).toMatchObject({
			status: 'invalid',
			id: 'broken',
			row: { id: 'broken', title: 'Broken' },
		});
		expect(Array.isArray(body.errors)).toBe(true);
		expect(body.errors.length).toBeGreaterThan(0);
	});

	test('PUT /:workspaceId/tables/:table/:id creates or replaces a row (200)', async () => {
		const { client, app } = setup();

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/post-3', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Created', content: 'with put', _v: 1 }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			status: 'valid',
			row: { id: 'post-3', title: 'Created', content: 'with put', _v: 1 },
		});
		expect(client.tables.posts.get('post-3')).toEqual({
			status: 'valid',
			row: { id: 'post-3', title: 'Created', content: 'with put', _v: 1 },
		});
	});

	test('PATCH /:workspaceId/tables/:table/:id updates specific fields (200)', async () => {
		const { client, app } = setup();

		client.tables.posts.set({
			id: 'post-1',
			title: 'Before',
			content: 'unchanged',
			_v: 1,
		});

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/post-1', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'After' }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			status: 'updated',
			row: { id: 'post-1', title: 'After', content: 'unchanged', _v: 1 },
		});
		expect(client.tables.posts.get('post-1')).toEqual({
			status: 'valid',
			row: { id: 'post-1', title: 'After', content: 'unchanged', _v: 1 },
		});
	});

	test('PATCH /:workspaceId/tables/:table/:id returns 404 when row does not exist', async () => {
		const { app } = setup();

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/missing-id', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'No row' }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			status: 'not_found',
			id: 'missing-id',
		});
	});

	test('DELETE /:workspaceId/tables/:table/:id removes row (200)', async () => {
		const { client, app } = setup();

		client.tables.posts.set({
			id: 'post-1',
			title: 'Delete me',
			content: 'bye',
			_v: 1,
		});

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/posts/post-1', {
				method: 'DELETE',
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ status: 'deleted' });
		expect(client.tables.posts.get('post-1')).toEqual({
			status: 'not_found',
			id: 'post-1',
			row: undefined,
		});
	});

	test('GET /:workspaceId/tables/:table returns 404 for unknown workspace', async () => {
		const { app } = setup();

		const response = await app.handle(
			new Request('http://test/unknown-workspace/tables/posts'),
		);

		expect(response.status).toBe(404);
	});

	test('GET /:workspaceId/tables/:table returns 404 for unknown table', async () => {
		const { app } = setup();

		const response = await app.handle(
			new Request('http://test/test-workspace/tables/nonexistent'),
		);

		expect(response.status).toBe(404);
	});
});
