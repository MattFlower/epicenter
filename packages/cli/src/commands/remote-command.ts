import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteServer } from '@epicenter/server-remote';
import type { Argv, CommandModule } from 'yargs';

const DEFAULT_REMOTE_PORT = 3914;

/**
 * Build the top-level `remote` command group for managing the remote Epicenter server.
 * @param home - Path to the Epicenter home directory (used for PID file storage).
 * @returns A yargs CommandModule with start, status, and stop subcommands.
 */
export function buildRemoteCommand(home: string): CommandModule {
	return {
		command: 'remote <subcommand>',
		describe: 'Manage the remote Epicenter server',
		builder: (y: Argv) =>
			y
				.command(buildRemoteStartCommand(home))
				.command(buildRemoteStatusCommand())
				.command(buildRemoteStopCommand(home))
				.demandCommand(1, 'Specify a subcommand: start, status, stop')
				.strict(),
		handler: () => {},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// remote start
// ═══════════════════════════════════════════════════════════════════════════

function buildRemoteStartCommand(home: string) {
	return {
		command: 'start',
		describe: 'Start the remote Epicenter server',
		builder: (y: Argv) =>
			y.option('port', {
				type: 'number' as const,
				default: DEFAULT_REMOTE_PORT,
				description: 'Port to run the server on',
			}),
		handler: async (argv: { port: number }) => {
			const server = createRemoteServer({ port: argv.port });
			server.start();

			console.log(`\nEpicenter remote server on http://localhost:${argv.port}`);
			console.log(`API docs: http://localhost:${argv.port}/openapi\n`);

			// Write PID file so `remote stop` can signal this process
			const pidFile = join(home, 'remote.pid');
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
// remote status
// ═══════════════════════════════════════════════════════════════════════════

function buildRemoteStatusCommand() {
	return {
		command: 'status',
		describe: 'Show the status of the remote Epicenter server',
		builder: (y: Argv) =>
			y.option('url', {
				type: 'string' as const,
				default: `http://localhost:${DEFAULT_REMOTE_PORT}`,
				description: 'URL of the remote server',
			}),
		handler: async (argv: { url: string }) => {
			let response: Response;
			try {
				response = await fetch(argv.url);
			} catch {
				console.error(
					`No Epicenter remote server running at ${argv.url}.\n` +
						`Start one with: epicenter remote start`,
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
			};

			console.log(
				`Server: ${info.name ?? 'Epicenter Remote'} v${info.version ?? 'unknown'}`,
			);
			console.log(`Mode:   ${info.mode ?? 'unknown'}`);
			console.log(`URL:    ${argv.url}`);
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// remote stop
// ═══════════════════════════════════════════════════════════════════════════

function buildRemoteStopCommand(home: string) {
	return {
		command: 'stop',
		describe: 'Stop the remote Epicenter server',
		builder: (y: Argv) => y,
		handler: async () => {
			const pidFile = join(home, 'remote.pid');

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
						`The remote server may not be running, or was not started with "epicenter remote start".`,
				);
				process.exitCode = 1;
				return;
			}

			try {
				process.kill(pid, 'SIGTERM');
				console.log(`Sent SIGTERM to remote server (PID ${pid}).`);
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
