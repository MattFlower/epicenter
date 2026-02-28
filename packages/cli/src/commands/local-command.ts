import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { discoverWorkspaces, resolveWorkspace } from '../discovery';
import { outputError } from '../format-output';
import { workspacesDir } from '../paths';

/** Default port for the local Epicenter server. */
const DEFAULT_PORT = 3913;

/**
 * Build the `local` command group with subcommands for managing the local Epicenter server.
 * @param home - Epicenter home directory path.
 * @returns A yargs CommandModule for the `local` command.
 */
export function buildLocalCommand(home: string): CommandModule {
	return {
		command: 'local <subcommand>',
		describe: 'Manage the local Epicenter server',
		builder: (y: Argv) =>
			y
				.command(buildLocalStartCommand(home))
				.command(buildLocalStatusCommand())
				.command(buildLocalStopCommand(home))
				.demandCommand(1, 'Specify a subcommand: start, status, stop')
				.strict(),
		handler: () => {},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// local start
// ═══════════════════════════════════════════════════════════════════════════

function buildLocalStartCommand(home: string) {
	return {
		command: 'start',
		describe: 'Start the local Epicenter server',
		builder: (y: Argv) =>
			y
				.option('workspace', {
					alias: 'w',
					type: 'string' as const,
					description:
						'Load only this workspace ID (run single-workspace mode)',
				})
				.option('remote', {
					type: 'string' as const,
					description:
						'Remote server URL for sync and auth (e.g. wss://remote.example.com)',
				})
				.option('port', {
					type: 'number' as const,
					default: DEFAULT_PORT,
					description: 'Port to run the server on',
				})
				.option('watch', {
					alias: 'W',
					type: 'boolean' as const,
					default: false,
					description:
						'Restart server when workspace config files change (uses bun --watch)',
				}),
		handler: async (argv: {
			workspace?: string;
			remote?: string;
			port: number;
			watch: boolean;
		}) => {
			if (argv.watch) {
				// Re-exec with bun --watch, stripping --watch/-W to avoid recursion
				const args = process.argv.filter((a) => a !== '--watch' && a !== '-W');
				const proc = Bun.spawn(['bun', '--watch', ...args], {
					stdio: ['inherit', 'inherit', 'inherit'],
				});
				process.exitCode = await proc.exited;
				return;
			}

			const { createLocalServer } = await import('@epicenter/server-local');

			let clients: Awaited<ReturnType<typeof discoverWorkspaces>>['clients'];
			let sources: Awaited<ReturnType<typeof discoverWorkspaces>>['sources'];

			if (argv.workspace) {
				const wsId = argv.workspace;
				const wsDir = join(workspacesDir(home), wsId);
				const resolution = await resolveWorkspace(wsDir);

				if (resolution.status === 'not_found') {
					outputError(`Workspace "${wsId}" not found at ${wsDir}`);
					process.exitCode = 1;
					return;
				}

				if (resolution.status === 'ambiguous') {
					outputError(
						`Ambiguous workspace at "${wsDir}". Found multiple configs:\n` +
							resolution.configs.map((c) => `  - ${c}`).join('\n'),
					);
					process.exitCode = 1;
					return;
				}

				clients = [resolution.client];
				sources = new Map([[resolution.client.id, resolution.projectDir]]);
			} else {
				({ clients, sources } = await discoverWorkspaces(home));
			}

			if (clients.length === 0) {
				console.log('No workspaces found. Starting server with no workspaces.');
			} else {
				console.log(`\nLoaded ${clients.length} workspace(s):`);
				for (const [id, path] of sources) {
					console.log(`  - ${id} (${path})`);
				}
			}

			const server = createLocalServer({
				clients,
				port: argv.port,
				...(argv.remote ? { remoteUrl: argv.remote } : {}),
			});
			server.start();

			console.log(`\nEpicenter local server on http://localhost:${argv.port}`);
			if (argv.remote) {
				console.log(`Syncing to remote: ${argv.remote}`);
			}
			console.log(`API docs: http://localhost:${argv.port}/openapi\n`);

			// Write PID file so `local stop` can signal this process
			const pidFile = join(home, 'local.pid');
			await writeFile(pidFile, String(process.pid), 'utf8');

			const shutdown = async () => {
				await server.stop();
				process.exit(0);
			};
			process.on('SIGINT', shutdown);
			process.on('SIGTERM', shutdown);

			await new Promise(() => {});
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// local status
// ═══════════════════════════════════════════════════════════════════════════

function buildLocalStatusCommand() {
	return {
		command: 'status',
		describe: 'Show the status of the local Epicenter server',
		builder: (y: Argv) =>
			y.option('port', {
				type: 'number' as const,
				default: DEFAULT_PORT,
				description: 'Port the server is running on',
			}),
		handler: async (argv: { port: number }) => {
			const url = `http://localhost:${argv.port}/`;

			let response: Response;
			try {
				response = await fetch(url);
			} catch {
				console.error(
					`No Epicenter local server running on http://localhost:${argv.port}.\n` +
						`Start one with: epicenter local start`,
				);
				process.exitCode = 1;
				return;
			}

			if (!response.ok) {
				console.error(
					`Server responded with ${response.status} ${response.statusText}`,
				);
				process.exitCode = 1;
				return;
			}

			const info = (await response.json()) as {
				name?: string;
				version?: string;
				mode?: string;
				workspaces?: string[];
			};

			console.log(
				`Server: ${info.name ?? 'Epicenter Local'} v${info.version ?? 'unknown'}`,
			);
			console.log(`Mode:   ${info.mode ?? 'unknown'}`);
			console.log(`URL:    http://localhost:${argv.port}`);

			if (info.workspaces && info.workspaces.length > 0) {
				console.log(`\nWorkspaces (${info.workspaces.length}):`);
				for (const id of info.workspaces) {
					console.log(`  - ${id}`);
				}
			} else {
				console.log('\nNo workspaces loaded.');
			}
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// local stop
// ═══════════════════════════════════════════════════════════════════════════

function buildLocalStopCommand(home: string) {
	return {
		command: 'stop',
		describe: 'Stop the local Epicenter server',
		builder: (y: Argv) => y,
		handler: async () => {
			const pidFile = join(home, 'local.pid');

			let pid: number;
			try {
				const raw = await readFile(pidFile, 'utf8');
				pid = Number.parseInt(raw.trim(), 10);
				if (Number.isNaN(pid)) {
					throw new Error('PID file contains invalid content');
				}
			} catch {
				console.error(
					`No PID file found at ${pidFile}.\n` +
						`The local server may not be running, or was not started with "epicenter local start".`,
				);
				process.exitCode = 1;
				return;
			}

			try {
				process.kill(pid, 'SIGTERM');
				console.log(`Sent SIGTERM to local server (PID ${pid}).`);
			} catch (err) {
				const isNoSuchProcess =
					err instanceof Error &&
					'code' in err &&
					(err as NodeJS.ErrnoException).code === 'ESRCH';

				if (isNoSuchProcess) {
					console.log(
						`Process ${pid} is no longer running (stale PID file). Cleaning up.`,
					);
					await unlink(pidFile).catch(() => {});
				} else {
					console.error(
						`Failed to stop server (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exitCode = 1;
				}
			}
		},
	};
}
