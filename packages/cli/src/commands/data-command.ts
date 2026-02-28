import type { Argv } from 'yargs';
import { formatYargsOptions, output, outputError } from '../format-output';
import { assertServerRunning, createHttpClient } from '../http-client';
import { parseJsonInput, readStdinSync } from '../parse-input';

/**
 * Build the top-level `data` command group for interacting with workspace data.
 * Provides subcommands for tables, key-value store, and actions.
 * @param serverUrl - Base URL of the Epicenter server to connect to.
 * @returns A yargs command definition with tables, kv, action, and table-row subcommands.
 */
export function buildDataCommand(serverUrl: string) {
	return {
		command: 'data <workspace>',
		describe: 'Interact with workspace data (tables, KV, actions)',
		builder: (yargs: Argv) => {
			const y = yargs.positional('workspace', {
				type: 'string',
				demandOption: true,
				description: 'Workspace ID',
			}) as Argv;
			return y
				.command(buildTablesSubcommand(serverUrl))
				.command(buildKvSubcommand(serverUrl))
				.command(buildActionSubcommand(serverUrl))
				.command(buildTableSubcommand(serverUrl))
				.demandCommand(
					1,
					'Specify a subcommand: tables, kv, action, or a table name',
				);
		},
		handler: () => {},
	};
}

// ---------------------------------------------------------------------------
// tables — list table names
// ---------------------------------------------------------------------------

function buildTablesSubcommand(serverUrl: string) {
	return {
		command: 'tables',
		describe: 'List all table names',
		builder: (yargs: any) => yargs.options(formatYargsOptions()),
		handler: async (argv: any) => {
			await assertServerRunning(serverUrl);
			const client = createHttpClient(serverUrl);
			const workspaceId = argv.workspace;

			try {
				const data = await client.get<string[]>(
					`/workspaces/${workspaceId}/tables`,
				);
				output(data, { format: argv.format as any });
			} catch (err) {
				outputError(String(err));
				process.exitCode = 1;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// kv — key-value store operations
// ---------------------------------------------------------------------------

function buildKvSubcommand(serverUrl: string) {
	return {
		command: 'kv <action>',
		describe: 'Manage key-value store',
		builder: (yargs: any) => {
			return yargs
				.command({
					command: 'get <key>',
					describe: 'Get a value by key',
					builder: (y: any) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						key: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const key = argv.key;

						try {
							const data = await client.get(
								`/workspaces/${workspaceId}/kv/${key}`,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							const msg = String(err);
							if (msg.includes('404')) {
								outputError(`Key not found: ${key}`);
							} else {
								outputError(msg);
							}
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'set <key> [value]',
					describe: 'Set a value by key',
					builder: (y: any) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.positional('value', {
								type: 'string',
								description: 'JSON value or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read value from file',
							})
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						key: string;
						value?: string;
						file?: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const key = argv.key;
						const stdinContent = readStdinSync();
						const valueStr = argv.value;

						let value: unknown;
						if (
							valueStr &&
							!valueStr.startsWith('{') &&
							!valueStr.startsWith('[') &&
							!valueStr.startsWith('"') &&
							!valueStr.startsWith('@')
						) {
							value = valueStr;
						} else {
							const result = parseJsonInput({
								positional: valueStr,
								file: argv.file,
								hasStdin: stdinContent !== undefined,
								stdinContent,
							});

							if (!result.ok) {
								outputError(result.error);
								process.exitCode = 1;
								return;
							}
							value = result.data;
						}

						try {
							await client.put(`/workspaces/${workspaceId}/kv/${key}`, value);
							output(
								{ status: 'set', key, value },
								{ format: argv.format as any },
							);
						} catch (err) {
							outputError(String(err));
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'delete <key>',
					aliases: ['reset'],
					describe: 'Delete a value by key (reset to undefined)',
					builder: (y: any) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						key: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const key = argv.key;

						try {
							await client.delete(`/workspaces/${workspaceId}/kv/${key}`);
							output(
								{ status: 'deleted', key },
								{ format: argv.format as any },
							);
						} catch (err) {
							outputError(String(err));
							process.exitCode = 1;
						}
					},
				})
				.demandCommand(1, 'Specify an action: get, set, delete');
		},
		handler: () => {},
	};
}

// ---------------------------------------------------------------------------
// action — run workspace actions (GET or POST)
// ---------------------------------------------------------------------------

function buildActionSubcommand(serverUrl: string) {
	return {
		command: 'action <path> [json]',
		describe: 'Run an action (query or mutation)',
		builder: (yargs: any) =>
			yargs
				.positional('path', {
					type: 'string',
					demandOption: true,
					description: 'Action path in dot notation (e.g., posts.getAll)',
				})
				.positional('json', {
					type: 'string',
					description: 'JSON input or @file (triggers mutation)',
				})
				.option('file', {
					type: 'string',
					description: 'Read input from file',
				})
				.option('mutation', {
					type: 'boolean',
					description: 'Force mutation (POST) even without input',
					default: false,
				}),
		handler: async (argv: any) => {
			await assertServerRunning(serverUrl);
			const client = createHttpClient(serverUrl);
			const workspaceId = argv.workspace;
			// Convert dot-notation to slash path: auth.login → auth/login
			const actionPath = argv.path.replace(/\./g, '/');
			const stdinContent = readStdinSync();
			const hasInput =
				argv.json !== undefined ||
				argv.file !== undefined ||
				stdinContent !== undefined;

			const url = `/workspaces/${workspaceId}/actions/${actionPath}`;

			try {
				if (hasInput || argv.mutation) {
					let body: unknown = undefined;
					if (hasInput) {
						const result = parseJsonInput({
							positional: argv.json,
							file: argv.file,
							hasStdin: stdinContent !== undefined,
							stdinContent,
						});
						if (!result.ok) {
							outputError(result.error);
							process.exitCode = 1;
							return;
						}
						body = result.data;
					}
					const data = await client.post(url, body);
					output(data);
				} else {
					const data = await client.get(url);
					output(data);
				}
			} catch (err) {
				outputError(String(err));
				process.exitCode = 1;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// <table> — table row operations (list, get, set, update, delete)
// ---------------------------------------------------------------------------

function buildTableSubcommand(serverUrl: string) {
	return {
		command: '<table> <action>',
		describe: 'Manage rows in a table',
		builder: (yargs: any) => {
			return yargs
				.positional('table', {
					type: 'string',
					demandOption: true,
					description: 'Table name',
				})
				.command({
					command: 'list',
					describe: 'List all valid rows',
					builder: (y: any) => y.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						table: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const tableName = argv.table;

						try {
							const data = await client.get(
								`/workspaces/${workspaceId}/tables/${tableName}`,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							outputError(String(err));
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'get <id>',
					describe: 'Get a row by ID',
					builder: (y: any) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						table: string;
						id: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const tableName = argv.table;
						const id = argv.id;

						try {
							const data = await client.get(
								`/workspaces/${workspaceId}/tables/${tableName}/${id}`,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							const msg = String(err);
							if (msg.includes('404')) {
								outputError(`Row not found: ${id}`);
							} else {
								outputError(msg);
							}
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'set <id> [json]',
					describe: 'Create or replace a row by ID',
					builder: (y: any) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.positional('json', {
								type: 'string',
								description: 'JSON row data or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read from file',
							})
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						table: string;
						id: string;
						json?: string;
						file?: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const tableName = argv.table;
						const id = argv.id;
						const stdinContent = readStdinSync();

						const result = parseJsonInput({
							positional: argv.json,
							file: argv.file,
							hasStdin: stdinContent !== undefined,
							stdinContent,
						});

						if (!result.ok) {
							outputError(result.error);
							process.exitCode = 1;
							return;
						}

						try {
							const data = await client.put(
								`/workspaces/${workspaceId}/tables/${tableName}/${id}`,
								result.data,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							outputError(String(err));
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'update <id>',
					describe:
						'Partial update a row using flags (e.g., --title "New Title")',
					builder: (y: any) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions())
							.strict(false),
					handler: async (argv: {
						workspace: string;
						table: string;
						id: string;
						format?: string;
						[key: string]: unknown;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const tableName = argv.table;
						const id = argv.id;

						const reservedKeys = new Set([
							'_',
							'$0',
							'id',
							'table',
							'workspace',
							'format',
							'help',
							'version',
						]);
						const partial: Record<string, unknown> = {};

						for (const [key, value] of Object.entries(argv)) {
							if (!reservedKeys.has(key) && !key.includes('-')) {
								if (
									typeof value === 'string' &&
									(value.startsWith('{') || value.startsWith('['))
								) {
									try {
										partial[key] = JSON.parse(value);
									} catch {
										partial[key] = value;
									}
								} else {
									partial[key] = value;
								}
							}
						}

						if (Object.keys(partial).length === 0) {
							outputError(
								'No fields to update. Use flags like --title "New Title"',
							);
							process.exitCode = 1;
							return;
						}

						try {
							const data = await client.patch(
								`/workspaces/${workspaceId}/tables/${tableName}/${id}`,
								partial,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							const msg = String(err);
							if (msg.includes('404')) {
								outputError(`Row not found: ${id}`);
							} else {
								outputError(msg);
							}
							process.exitCode = 1;
						}
					},
				})
				.command({
					command: 'delete <id>',
					describe: 'Delete a row by ID',
					builder: (y: any) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv: {
						workspace: string;
						table: string;
						id: string;
						format?: string;
					}) => {
						await assertServerRunning(serverUrl);
						const client = createHttpClient(serverUrl);
						const workspaceId = argv.workspace;
						const tableName = argv.table;
						const id = argv.id;

						try {
							const data = await client.delete(
								`/workspaces/${workspaceId}/tables/${tableName}/${id}`,
							);
							output(data, { format: argv.format as any });
						} catch (err) {
							outputError(String(err));
							process.exitCode = 1;
						}
					},
				})
				.demandCommand(1, 'Specify an action: list, get, set, update, delete');
		},
		handler: () => {},
	};
}
