import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import { collectActionPaths, createActionsPlugin } from './actions';
import { createKvPlugin } from './kv';
import { createTablesPlugin } from './tables';

/**
 * Create an Elysia plugin that bundles tables + KV + actions for workspace clients.
 *
 * Uses parameterized routes (`/:workspaceId/tables/:tableName`, etc.) so that
 * Eden Treaty can infer the full type chain. Workspace and table resolution
 * happens at request time via the workspaces map.
 *
 * Mount under `/workspaces` (or any prefix) via Elysia:
 *
 * @example
 * ```typescript
 * const app = new Elysia()
 *   .use(new Elysia({ prefix: '/workspaces' })
 *     .use(createWorkspacePlugin(clients)))
 *   .listen(3913);
 * ```
 */
export function createWorkspacePlugin(clients: AnyWorkspaceClient[]) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	return new Elysia()
		.get(
			'/:workspaceId',
			({ params, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				return {
					id: workspace.id,
					tables: Object.keys(workspace.definitions.tables),
					kv: Object.keys(workspace.definitions.kv ?? {}),
					actions: workspace.actions
						? collectActionPaths(workspace.actions)
						: [],
				};
			},
			{
				detail: {
					description: 'Get workspace metadata',
					tags: ['workspaces'],
				},
			},
		)
		.use(createTablesPlugin(workspaces))
		.use(createKvPlugin(workspaces))
		.use(createActionsPlugin(workspaces));
}
