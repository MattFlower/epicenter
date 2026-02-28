import type { Action, Actions, AnyWorkspaceClient } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import Value from 'typebox/value';

/**
 * Resolve an action from a workspace's actions tree given a path.
 */
function resolveAction(
	actions: Actions,
	actionPath: string,
): Action | undefined {
	const segments = actionPath.split('/');
	let current: unknown = actions;

	for (const segment of segments) {
		if (typeof current !== 'object' || current === null) return undefined;
		if (typeof current === 'function') return undefined;
		current = (current as Record<string, unknown>)[segment];
		if (!current) return undefined;
	}

	if (
		typeof current === 'function' &&
		'type' in current &&
		(current.type === 'query' || current.type === 'mutation')
	) {
		return current as unknown as Action;
	}
	return undefined;
}

/**
 * Create an Elysia plugin for action endpoints.
 *
 * Registers per-action static routes at construction time by iterating over all
 * workspaces. Each route gets its own OpenAPI metadata (summary, tags).
 * Workspace resolution still happens at request time via :workspaceId param.
 */
export function createActionsPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	const router = new Elysia({ prefix: '/:workspaceId/actions' });

	// Collect unique action shapes across all workspaces.
	// Since workspaces may define the same action paths, we register
	// routes once and resolve the specific workspace at request time.
	const actionPaths = new Map<string, Set<'query' | 'mutation'>>();

	for (const workspace of Object.values(workspaces)) {
		if (!workspace.actions) continue;
		for (const [action, path] of iterateActions(workspace.actions)) {
			const routePath = path.join('/');
			const types = actionPaths.get(routePath) ?? new Set();
			types.add(action.type);
			actionPaths.set(routePath, types);
		}
	}

	for (const [actionPath, types] of actionPaths) {
		const routePath = `/${actionPath}`;

		const segments = actionPath.split('/');
		const namespaceTags = segments.length > 1 ? [segments[0] as string] : [];

		if (types.has('query')) {
			const detail = {
				summary: actionPath.replace(/\//g, '.'),
				tags: [...namespaceTags, 'query'],
			};

			router.get(
				routePath,
				async ({ params, query, status }) => {
					const workspace = workspaces[params.workspaceId];
					if (!workspace?.actions)
						return status('Not Found', {
							error: 'Workspace or actions not found',
						});

					const action = resolveAction(workspace.actions, actionPath);
					if (!action)
						return status('Not Found', {
							error: `Action not found: ${actionPath}`,
						});

					if (action.type !== 'query')
						return status('Bad Request', {
							error: `Action "${actionPath}" is a mutation, use POST`,
						});

					if (action.input) {
						if (!Value.Check(action.input, query))
							return status('Unprocessable Content', {
								errors: [...Value.Errors(action.input, query)],
							});
						return { data: await action(query) };
					}
					return { data: await action() };
				},
				{ detail },
			);
		}

		if (types.has('mutation')) {
			const detail = {
				summary: actionPath.replace(/\//g, '.'),
				tags: [...namespaceTags, 'mutation'],
			};

			router.post(
				routePath,
				async ({ params, body, status }) => {
					const workspace = workspaces[params.workspaceId];
					if (!workspace?.actions)
						return status('Not Found', {
							error: 'Workspace or actions not found',
						});

					const action = resolveAction(workspace.actions, actionPath);
					if (!action)
						return status('Not Found', {
							error: `Action not found: ${actionPath}`,
						});

					if (action.type !== 'mutation')
						return status('Bad Request', {
							error: `Action "${actionPath}" is a query, use GET`,
						});

					if (action.input) {
						if (!Value.Check(action.input, body))
							return status('Unprocessable Content', {
								errors: [...Value.Errors(action.input, body)],
							});
						return { data: await action(body) };
					}
					return { data: await action() };
				},
				{ detail },
			);
		}
	}

	return router;
}

/**
 * Collect action paths for logging/discovery.
 */
export function collectActionPaths(actions: Actions): string[] {
	return [...iterateActions(actions)].map(([, path]) => path.join('/'));
}
