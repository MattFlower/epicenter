// packages/cli/src/commands/auth-command.ts
import type { Argv, CommandModule } from 'yargs';
import { clearAuth, loadAuth, saveAuth } from '../auth-store';
import { createHttpClient } from '../http-client';

/** Response from the email sign-in endpoint. */
interface SignInResponse {
	token: string;
	expiresAt: string;
	user: { id: string; email: string; name?: string };
}

/** Response from the get-session endpoint used to verify auth status. */
interface SessionResponse {
	user: { id: string; email: string; name?: string };
	expiresAt: string;
	valid: boolean;
}

async function readLine(prompt: string, silent = false): Promise<string> {
	const readline = await import('node:readline');

	const inputStream = process.stdin;
	let outputStream: NodeJS.WritableStream;

	if (silent) {
		const { Writable } = await import('node:stream');
		outputStream = new Writable({
			write(_, __, cb) {
				cb();
			},
		});
	} else {
		outputStream = process.stdout;
	}

	const rl = readline.createInterface({
		input: inputStream,
		output: outputStream,
		terminal: true,
	});

	process.stdout.write(prompt);

	return new Promise((resolve) => {
		rl.once('line', (line) => {
			if (silent) process.stdout.write('\n');
			rl.close();
			resolve(line);
		});
	});
}

function buildLoginCommand(home: string) {
	return {
		command: 'login',
		describe: 'Log in to a remote Epicenter server',
		builder: (yargs: Argv) =>
			yargs.option('remote', {
				type: 'string',
				description:
					'Remote server URL (e.g. https://my-epicenter.example.com)',
			}),
		handler: async (argv: { remote?: string }) => {
			let remoteUrl = argv.remote;

			if (!remoteUrl) {
				const stored = await loadAuth(home);
				if (stored?.remoteUrl) {
					remoteUrl = stored.remoteUrl;
				} else {
					console.error(
						'No remote URL provided and no stored remote URL found.\n' +
							'Provide one with: epicenter auth login --remote <url>',
					);
					process.exit(1);
				}
			}

			const email = await readLine('Email: ');
			const password = await readLine('Password: ', true);

			const client = createHttpClient(remoteUrl);

			let response: SignInResponse;
			try {
				response = await client.post<SignInResponse>(
					'/api/auth/sign-in/email',
					{ email, password },
				);
			} catch (err) {
				console.error(`Login failed: ${(err as Error).message}`);
				process.exit(1);
			}

			await saveAuth(home, {
				remoteUrl,
				token: response.token,
				expiresAt: response.expiresAt,
				user: response.user,
			});

			const displayName = response.user.name ?? response.user.email;
			console.log(`Logged in as ${displayName} (${response.user.email})`);
		},
	};
}

function buildLogoutCommand(home: string) {
	return {
		command: 'logout',
		describe: 'Log out from the remote Epicenter server',
		builder: (yargs: Argv) => yargs,
		handler: async () => {
			const auth = await loadAuth(home);
			if (!auth) {
				console.log('You are not logged in.');
				return;
			}

			try {
				const client = createHttpClient(auth.remoteUrl, auth.token);
				await client.post('/api/auth/sign-out');
			} catch {
				// Remote may be unreachable; proceed with local logout anyway
			}

			await clearAuth(home);
			console.log('Logged out successfully.');
		},
	};
}

function buildStatusCommand(home: string) {
	return {
		command: 'status',
		describe: 'Show current authentication status',
		builder: (yargs: Argv) => yargs,
		handler: async () => {
			const auth = await loadAuth(home);
			if (!auth) {
				console.log('Not logged in.');
				return;
			}

			const client = createHttpClient(auth.remoteUrl, auth.token);

			try {
				const session = await client.get<SessionResponse>(
					'/api/auth/get-session',
				);
				const displayName = session.user.name ?? session.user.email;
				console.log(`Logged in as: ${displayName} (${session.user.email})`);
				console.log(`Remote:       ${auth.remoteUrl}`);
				console.log(`Session:      ${session.valid ? 'valid' : 'invalid'}`);
				if (session.expiresAt) {
					console.log(
						`Expires at:   ${new Date(session.expiresAt).toLocaleString()}`,
					);
				}
			} catch {
				// Token may be expired or remote unreachable — show stored info with a warning
				const displayName = auth.user?.name ?? auth.user?.email ?? '(unknown)';
				console.log(
					`Logged in as: ${displayName}${auth.user?.email ? ` (${auth.user.email})` : ''} [stored]`,
				);
				console.log(`Remote:       ${auth.remoteUrl}`);
				console.log(
					`Expires at:   ${auth.expiresAt ? new Date(auth.expiresAt).toLocaleString() : '(unknown)'}`,
				);
				console.warn(
					'Warning: Could not verify session with remote server. Token may be expired or server unreachable.',
				);
			}
		},
	};
}

/**
 * Build the top-level `auth` command group for managing authentication with a remote server.
 * @param home - Path to the Epicenter home directory (used for credential storage).
 * @returns A yargs CommandModule with login, logout, and status subcommands.
 */
export function buildAuthCommand(home: string): CommandModule {
	return {
		command: 'auth <subcommand>',
		describe: 'Manage authentication with a remote Epicenter server',
		builder: (yargs: Argv) =>
			yargs
				.command(buildLoginCommand(home) as CommandModule)
				.command(buildLogoutCommand(home) as CommandModule)
				.command(buildStatusCommand(home) as CommandModule)
				.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
		handler: () => {},
	};
}
