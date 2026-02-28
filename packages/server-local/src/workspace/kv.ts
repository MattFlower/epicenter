import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';

/**
 * Create an Elysia plugin that exposes GET, PUT, and DELETE routes for all workspace KV entries.
 * Registers one route per KV key found across all workspaces.
 * @param workspaces - Map of workspace ID to workspace client.
 * @returns An Elysia router scoped to `/:workspaceId/kv`.
 */
export function createKvPlugin(workspaces: Record<string, AnyWorkspaceClient>) {
	const kvKeys = new Set<string>();
	for (const workspace of Object.values(workspaces)) {
		for (const name of Object.keys(workspace.definitions.kv)) {
			kvKeys.add(name);
		}
	}

	const router = new Elysia({ prefix: '/:workspaceId/kv' });

	for (const key of kvKeys) {
		router.get(
			`/${key}`,
			({ params, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					const result = workspace.kv.get(key);
					if (result.status === 'not_found') return status('Not Found', result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: {
					description: `Get the value of the ${key} KV entry`,
					tags: [key, 'kv'],
				},
			},
		);

		router.put(
			`/${key}`,
			({ params, body, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					workspace.kv.set(key, body as never);
					return { status: 'set' as const, key };
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: {
					description: `Set the value of the ${key} KV entry`,
					tags: [key, 'kv'],
				},
			},
		);

		router.delete(
			`/${key}`,
			({ params, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					workspace.kv.delete(key);
					return { status: 'deleted' as const, key };
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: {
					description: `Delete the ${key} KV entry`,
					tags: [key, 'kv'],
				},
			},
		);
	}

	return router;
}
