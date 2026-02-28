import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type GenerateConfigOptions,
	generateOpenCodeConfigContent,
} from './config';

/**
 * XDG directory structure for an isolated OpenCode instance.
 *
 * Each path maps to the XDG variable that OpenCode reads.
 * Setting all four ensures complete isolation from any
 * user-installed OpenCode instance.
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */
type XdgPaths = {
	/** XDG_CONFIG_HOME — config, plugins, agents, commands. */
	config: string;
	/** XDG_DATA_HOME — auth, sessions, logs. */
	data: string;
	/** XDG_CACHE_HOME — node_modules, cached models. */
	cache: string;
	/** XDG_STATE_HOME — runtime state. */
	state: string;
};

/**
 * Compute XDG paths for an OpenCode instance isolated to `appDataDir`.
 *
 * All four XDG directories are nested under `{appDataDir}/opencode/`
 * so the entire OpenCode footprint lives inside the Epicenter app folder.
 *
 * @example
 * ```typescript
 * const paths = xdgPaths('/Users/me/Library/Application Support/Epicenter');
 * // paths.config = '/Users/me/Library/Application Support/Epicenter/opencode/config'
 * // paths.data   = '/Users/me/Library/Application Support/Epicenter/opencode/data'
 * // paths.cache  = '/Users/me/Library/Application Support/Epicenter/opencode/cache'
 * // paths.state  = '/Users/me/Library/Application Support/Epicenter/opencode/state'
 * ```
 */
function xdgPaths(appDataDir: string): XdgPaths {
	const base = join(appDataDir, 'opencode');
	return {
		config: join(base, 'config'),
		data: join(base, 'data'),
		cache: join(base, 'cache'),
		state: join(base, 'state'),
	};
}

export type OpenCodeProcessConfig = {
	/**
	 * Epicenter app data directory.
	 *
	 * On macOS: `~/Library/Application Support/Epicenter`
	 * On Linux: `~/.local/share/Epicenter`
	 * On Windows: `%APPDATA%/Epicenter`
	 *
	 * OpenCode's XDG directories are created under `{appDataDir}/opencode/`.
	 */
	appDataDir: string;

	/**
	 * Remote server URL for provider proxy routing.
	 *
	 * Passed through to `generateOpenCodeConfigContent`.
	 */
	remoteUrl: string;

	/**
	 * Better Auth session token.
	 *
	 * Used as the `apiKey` for all providers. The remote server proxy validates
	 * this token and swaps it for the real API key.
	 */
	sessionToken: string;

	/**
	 * Port for the local OpenCode server.
	 *
	 * Defaults to 4096 (OpenCode's default). Each OpenCode instance
	 * needs a unique port if multiple are running.
	 */
	port?: number;

	/**
	 * Path to the OpenCode binary.
	 *
	 * Defaults to `'opencode'` (found via PATH). Can be set to an
	 * absolute path for bundled sidecar binaries.
	 */
	binary?: string;

	/**
	 * Additional environment variables to pass to the OpenCode process.
	 *
	 * Merged with the XDG isolation vars and `OPENCODE_CONFIG_CONTENT`.
	 * Useful for passing `OPENCODE_SERVER_PASSWORD` or other overrides.
	 */
	env?: Record<string, string>;
};

export type OpenCodeProcess = {
	/**
	 * Start the OpenCode server process.
	 *
	 * Creates XDG directories if they don't exist, generates the config
	 * content, and spawns `opencode serve --port {port}` with full
	 * XDG isolation.
	 *
	 * No-op if already running.
	 */
	start(): Promise<void>;

	/**
	 * Stop the OpenCode server process.
	 *
	 * Sends SIGTERM, waits for graceful shutdown. No-op if not running.
	 */
	stop(): Promise<void>;

	/**
	 * Restart with optional new config.
	 *
	 * Stops the current process, then starts a new one. Useful after
	 * session token refresh — the new token is injected via
	 * `OPENCODE_CONFIG_CONTENT` without the user noticing.
	 *
	 * @param newConfig - Optional partial config overrides (e.g., new sessionToken).
	 */
	restart(
		newConfig?: Partial<
			Pick<OpenCodeProcessConfig, 'sessionToken' | 'remoteUrl'>
		>,
	): Promise<void>;

	/** Whether the OpenCode process is currently running. */
	isRunning(): boolean;

	/**
	 * The port the OpenCode server is listening on.
	 *
	 * Useful for constructing the local OpenCode API URL
	 * (e.g., `http://localhost:${port}/session`).
	 */
	port: number;

	/**
	 * Update the provider config on a running OpenCode instance.
	 *
	 * Uses OpenCode's `PATCH /config` endpoint to update provider
	 * configuration without restarting the process. Useful for
	 * session token refresh.
	 *
	 * @param configOptions - New config generation options (remoteUrl + sessionToken).
	 * @returns true if the config was updated successfully, false otherwise.
	 */
	updateConfig(
		configOptions: Pick<GenerateConfigOptions, 'remoteUrl' | 'sessionToken'>,
	): Promise<boolean>;
};

const DEFAULT_PORT = 4096;
const DEFAULT_BINARY = 'opencode';

/**
 * Create an XDG-isolated OpenCode process manager.
 *
 * Manages the full lifecycle of a local OpenCode instance: start, stop,
 * restart, and runtime config updates. The process runs with complete
 * XDG isolation — all data lives under `{appDataDir}/opencode/`, separate
 * from any user-installed OpenCode.
 *
 * Provider configuration is injected via `OPENCODE_CONFIG_CONTENT` at
 * spawn time. Each provider's `baseURL` points to the remote server's proxy
 * (`{remoteUrl}/proxy/{provider}`), and the `apiKey` is the session token.
 * Keys never leave the remote server.
 *
 * @example
 * ```typescript
 * const opencode = createOpenCodeProcess({
 *   appDataDir: '/Users/me/Library/Application Support/Epicenter',
 *   remoteUrl: 'http://localhost:3913',
 *   sessionToken: 'ses_abc123...',
 * });
 *
 * await opencode.start();
 * console.log(`OpenCode running on port ${opencode.port}`);
 *
 * // Later: refresh token without restart
 * await opencode.updateConfig({
 *   remoteUrl: 'http://localhost:3913',
 *   sessionToken: 'ses_newtoken...',
 * });
 *
 * // Cleanup
 * await opencode.stop();
 * ```
 */
export function createOpenCodeProcess(
	config: OpenCodeProcessConfig,
): OpenCodeProcess {
	const { appDataDir, binary = DEFAULT_BINARY, env: extraEnv = {} } = config;
	let { remoteUrl, sessionToken } = config;
	const port = config.port ?? DEFAULT_PORT;
	const paths = xdgPaths(appDataDir);

	let childProcess: ReturnType<typeof Bun.spawn> | null = null;

	return {
		port,

		async start() {
			if (childProcess && !childProcess.killed) return;

			// Ensure XDG directories exist
			await Promise.all([
				mkdir(paths.config, { recursive: true }),
				mkdir(paths.data, { recursive: true }),
				mkdir(paths.cache, { recursive: true }),
				mkdir(paths.state, { recursive: true }),
			]);

			const configContent = generateOpenCodeConfigContent({
				remoteUrl,
				sessionToken,
			});

			childProcess = Bun.spawn([binary, 'serve', '--port', String(port)], {
				env: {
					...process.env,
					XDG_CONFIG_HOME: paths.config,
					XDG_DATA_HOME: paths.data,
					XDG_CACHE_HOME: paths.cache,
					XDG_STATE_HOME: paths.state,
					OPENCODE_CONFIG_CONTENT: configContent,
					...extraEnv,
				},
				stdout: 'inherit',
				stderr: 'inherit',
			});
		},

		async stop() {
			if (!childProcess || childProcess.killed) {
				childProcess = null;
				return;
			}

			childProcess.kill('SIGTERM');

			// Wait for graceful shutdown (up to 5 seconds)
			const timeout = setTimeout(() => {
				if (childProcess && !childProcess.killed) {
					childProcess.kill('SIGKILL');
				}
			}, 5000);

			await childProcess.exited;
			clearTimeout(timeout);
			childProcess = null;
		},

		async restart(newConfig) {
			if (newConfig?.remoteUrl) remoteUrl = newConfig.remoteUrl;
			if (newConfig?.sessionToken) sessionToken = newConfig.sessionToken;

			await this.stop();
			await this.start();
		},

		isRunning() {
			return childProcess !== null && !childProcess.killed;
		},

		async updateConfig(configOptions) {
			if (!this.isRunning()) return false;

			const { generateOpenCodeConfig } = await import('./config');
			const newConfig = generateOpenCodeConfig({
				remoteUrl: configOptions.remoteUrl,
				sessionToken: configOptions.sessionToken,
			});

			try {
				const response = await fetch(`http://localhost:${port}/config`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(newConfig),
				});
				return response.ok;
			} catch {
				// OpenCode server not responding — probably still starting
				return false;
			}
		},
	};
}
