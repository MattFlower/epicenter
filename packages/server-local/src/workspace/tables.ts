import type {
	AnyWorkspaceClient,
	BaseRow,
	TableHelper,
} from '@epicenter/workspace';
import { Elysia } from 'elysia';

function resolveTable(
	workspaces: Record<string, AnyWorkspaceClient>,
	workspaceId: string,
	tableName: string,
): TableHelper<BaseRow> | undefined {
	const workspace = workspaces[workspaceId];
	if (!workspace) return undefined;
	return (workspace.tables as Record<string, TableHelper<BaseRow>>)[tableName];
}

/**
 * Create an Elysia plugin that exposes CRUD routes for all workspace tables.
 * Registers GET (list/get-by-id), PUT (create/replace), PATCH (partial update),
 * and DELETE routes for each table name found across all workspaces.
 * @param workspaces - Map of workspace ID to workspace client.
 * @returns An Elysia router scoped to `/:workspaceId/tables`.
 */
export function createTablesPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	const tableNames = new Set<string>();
	for (const workspace of Object.values(workspaces)) {
		for (const name of Object.keys(workspace.definitions.tables)) {
			tableNames.add(name);
		}
	}

	const router = new Elysia({ prefix: '/:workspaceId/tables' });

	for (const tableName of tableNames) {
		router.get(
			`/${tableName}`,
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				return tableHelper.getAllValid();
			},
			{
				detail: {
					description: `List all rows in the ${tableName} table`,
					tags: [tableName, 'tables'],
				},
			},
		);

		router.get(
			`/${tableName}/:id`,
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.get(params.id);
				if (result.status === 'not_found') return status('Not Found', result);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				return result;
			},
			{
				detail: {
					description: `Get a row by ID from the ${tableName} table`,
					tags: [tableName, 'tables'],
				},
			},
		);

		router.put(
			`/${tableName}/:id`,
			({ params, body, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.parse(params.id, body);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				tableHelper.set(result.row);
				return result;
			},
			{
				detail: {
					description: `Create or replace a row by ID in the ${tableName} table`,
					tags: [tableName, 'tables'],
				},
			},
		);

		router.patch(
			`/${tableName}/:id`,
			({ params, body, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.update(
					params.id,
					body as Record<string, unknown>,
				);
				if (result.status === 'not_found') return status('Not Found', result);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				return result;
			},
			{
				detail: {
					description: `Partially update a row by ID in the ${tableName} table`,
					tags: [tableName, 'tables'],
				},
			},
		);

		router.delete(
			`/${tableName}/:id`,
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				return tableHelper.delete(params.id);
			},
			{
				detail: {
					description: `Delete a row by ID from the ${tableName} table`,
					tags: [tableName, 'tables'],
				},
			},
		);
	}

	return router;
}
