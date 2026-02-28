import { describe, expect, test } from 'bun:test';
import { DEFAULT_PORT } from '@epicenter/server';
import {
	createWorkspace,
	defineQuery,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';
import { type } from 'arktype';
import { createLocalServer } from './local';

describe('createLocalServer', () => {
	test('DEFAULT_PORT is 3913', () => {
		expect(DEFAULT_PORT).toBe(3913);
	});

	test('GET / returns discovery payload with workspace ids and actions', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'discovery-workspace',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		const server = createLocalServer({ clients: [client] });

		try {
			const response = await server.app.handle(new Request('http://test/'));
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body).toEqual({
				name: 'Epicenter Local',
				version: '1.0.0',
				mode: 'local',
				workspaces: ['discovery-workspace'],
				actions: [],
			});
		} finally {
			await client.destroy();
		}
	});

	test('GET /workspaces/:id/tables/:table is reachable through full server composition', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'tables-workspace',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		client.tables.posts.set({ id: 'post-1', title: 'Hello', _v: 1 });

		const server = createLocalServer({ clients: [client] });

		try {
			const response = await server.app.handle(
				new Request('http://test/workspaces/tables-workspace/tables/posts/'),
			);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body).toEqual([{ id: 'post-1', title: 'Hello', _v: 1 }]);
		} finally {
			await client.destroy();
		}
	});

	test('multiple workspaces are listed in discovery and both table routes work', async () => {
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

		const server = createLocalServer({ clients: [blogClient, docsClient] });

		try {
			const discoveryResponse = await server.app.handle(
				new Request('http://test/'),
			);
			const discoveryBody = await discoveryResponse.json();

			expect(discoveryResponse.status).toBe(200);
			expect(discoveryBody.workspaces).toEqual(['blog', 'docs']);

			const blogResponse = await server.app.handle(
				new Request('http://test/workspaces/blog/tables/posts/'),
			);
			const docsResponse = await server.app.handle(
				new Request('http://test/workspaces/docs/tables/pages/'),
			);

			expect(blogResponse.status).toBe(200);
			expect(docsResponse.status).toBe(200);
		} finally {
			await blogClient.destroy();
			await docsClient.destroy();
		}
	});

	test('discovery includes flattened action paths as workspaceId/actionPath', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'actions-workspace',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);
		const clientWithActions = Object.assign(client, {
			actions: {
				ping: defineQuery({ handler: () => 'pong' }),
				posts: {
					list: defineQuery({ handler: () => ['post-1'] }),
				},
			},
		});

		const server = createLocalServer({ clients: [clientWithActions] });

		try {
			const response = await server.app.handle(new Request('http://test/'));
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.actions).toContain('actions-workspace/ping');
			expect(body.actions).toContain('actions-workspace/posts/list');
		} finally {
			await client.destroy();
		}
	});

	test('start() listens on a random port and stop() shuts it down', async () => {
		const client = createWorkspace(
			defineWorkspace({
				id: 'lifecycle-workspace',
				tables: {
					posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
				},
			}),
		);

		const server = createLocalServer({ clients: [client], port: 0 });
		const runningServer = server.start();
		let didDestroyWorkspace = false;
		client.ydoc.on('destroy', () => {
			didDestroyWorkspace = true;
		});

		expect(runningServer).toBeDefined();
		if (!runningServer) {
			throw new Error('Expected start() to return a running server instance');
		}
		expect(runningServer.port).toBeGreaterThan(0);

		const url = `http://localhost:${runningServer.port}/`;
		const response = await fetch(url);
		expect(response.status).toBe(200);

		await server.stop();
		expect(didDestroyWorkspace).toBe(true);
	});
});
