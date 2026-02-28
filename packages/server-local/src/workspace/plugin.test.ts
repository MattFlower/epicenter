import { describe, expect, test } from 'bun:test';
import {
	createWorkspace,
	defineQuery,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';
import { Elysia } from 'elysia';
import { createWorkspacePlugin } from './plugin';

describe('createWorkspacePlugin', () => {
	test('mounts a single workspace client under /{workspaceId}', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'blog',
				tables: {
					posts: defineTable(
						type({ id: 'string', title: 'string', content: 'string', _v: '1' }),
					),
				},
			}),
		);

		client.tables.posts.set({
			id: 'post-1',
			title: 'First',
			content: 'hello',
			_v: 1,
		});

		const app = new Elysia().use(createWorkspacePlugin([client]));
		const response = await app.handle(
			new Request('http://test/blog/tables/posts/'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual([
			{ id: 'post-1', title: 'First', content: 'hello', _v: 1 },
		]);
	});

	test('mounts multiple workspace clients and keeps table data isolated', async () => {
		const blogClient = createWorkspace(
			defineWorkspace({
				id: 'blog',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		const docsClient = createWorkspace(
			defineWorkspace({
				id: 'docs',
				tables: {
					pages: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		blogClient.tables.posts.set({ id: 'post-1', title: 'Blog Post', _v: 1 });
		docsClient.tables.pages.set({ id: 'page-1', title: 'Docs Page', _v: 1 });

		const app = new Elysia().use(
			createWorkspacePlugin([blogClient, docsClient]),
		);

		const blogResponse = await app.handle(
			new Request('http://test/blog/tables/posts/'),
		);
		const blogBody = await blogResponse.json();

		const docsResponse = await app.handle(
			new Request('http://test/docs/tables/pages/'),
		);
		const docsBody = await docsResponse.json();

		expect(blogResponse.status).toBe(200);
		expect(blogBody).toEqual([{ id: 'post-1', title: 'Blog Post', _v: 1 }]);
		expect(docsResponse.status).toBe(200);
		expect(docsBody).toEqual([{ id: 'page-1', title: 'Docs Page', _v: 1 }]);
	});

	test('mounts actions routes under /{workspaceId}/actions/{actionName}', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'blog',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		).withActions(() => ({
			ping: defineQuery({
				handler: () => 'pong',
			}),
		}));

		const app = new Elysia().use(createWorkspacePlugin([client]));
		const response = await app.handle(
			new Request('http://test/blog/actions/ping'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'pong' });
	});

	test('still mounts tables when client has no actions', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'notes',
				tables: {
					notes: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		client.tables.notes.set({ id: 'note-1', title: 'Remember this', _v: 1 });

		const app = new Elysia().use(createWorkspacePlugin([client]));

		const tablesResponse = await app.handle(
			new Request('http://test/notes/tables/notes/'),
		);
		const tablesBody = await tablesResponse.json();

		const actionsResponse = await app.handle(
			new Request('http://test/notes/actions/ping'),
		);
		const actionsBody = await actionsResponse.text();

		expect(tablesResponse.status).toBe(200);
		expect(tablesBody).toEqual([
			{ id: 'note-1', title: 'Remember this', _v: 1 },
		]);
		expect(actionsResponse.status).toBe(404);
		expect(actionsBody.length).toBeGreaterThan(0);
	});
});
