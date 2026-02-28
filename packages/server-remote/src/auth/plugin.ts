import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { Elysia } from 'elysia';

/**
 * Configuration for the Better Auth Elysia plugin.
 *
 * The auth plugin provides session-based authentication for the remote server.
 * It supports both cookie-based auth (browser) and Bearer token auth (desktop/API clients).
 */
export type AuthPluginConfig = {
	/**
	 * Database connection for Better Auth.
	 *
	 * Accepts a `bun:sqlite` Database instance (self-hosted)
	 * or a `pg` Pool instance (cloud/Postgres).
	 *
	 * @example
	 * ```typescript
	 * import { Database } from 'bun:sqlite';
	 * createAuthPlugin({ database: new Database('auth.db') });
	 * ```
	 */
	database: unknown;

	/**
	 * Secret key for signing session tokens.
	 *
	 * Falls back to `BETTER_AUTH_SECRET` or `AUTH_SECRET` env vars.
	 * Must be set in production.
	 */
	secret?: string;

	/**
	 * Trusted origins for CORS validation.
	 *
	 * Better Auth validates the Origin header against this list
	 * to prevent CSRF attacks. Include the Tauri webview origin
	 * and any other clients that will authenticate.
	 *
	 * @example
	 * ```typescript
	 * trustedOrigins: ['tauri://localhost', 'http://localhost:5173']
	 * ```
	 */
	trustedOrigins?: string[];

	/**
	 * Session configuration.
	 *
	 * Controls token lifetime and refresh behavior.
	 */
	session?: {
		/** Session token lifetime in seconds. Default: 7 days (604800). */
		expiresIn?: number;

		/** How often to extend session expiry on use, in seconds. Default: 1 day (86400). */
		updateAge?: number;
	};
};

/**
 * Create the Better Auth instance from config.
 *
 * Separated from the Elysia plugin so callers can access
 * `auth.api.getSession()` for token validation (e.g., local server → remote).
 *
 * @example
 * ```typescript
 * const auth = createBetterAuth({
 *   database: new Database('auth.db'),
 *   secret: 'my-secret',
 *   trustedOrigins: ['tauri://localhost'],
 * });
 *
 * // Validate a session from request headers
 * const session = await auth.api.getSession({ headers });
 * ```
 */
export function createBetterAuth(config: AuthPluginConfig) {
	return betterAuth({
		database: config.database as Parameters<typeof betterAuth>[0]['database'],
		basePath: '/auth',
		secret: config.secret,
		trustedOrigins: config.trustedOrigins,
		emailAndPassword: {
			enabled: true,
		},
		session: {
			expiresIn: config.session?.expiresIn ?? 60 * 60 * 24 * 7, // 7 days
			updateAge: config.session?.updateAge ?? 60 * 60 * 24, // 1 day
		},
		plugins: [bearer()],
	});
}

/**
 * Create an Elysia plugin that provides Better Auth authentication.
 *
 * Mounts Better Auth's handler at `/auth/*` and provides an `auth` macro
 * for protecting routes with session validation.
 *
 * Registers routes:
 *
 * | Method | Route                | Description                    |
 * | ------ | -------------------- | ------------------------------ |
 * | `POST` | `/auth/sign-up/email`| Register with email + password |
 * | `POST` | `/auth/sign-in/email`| Login with email + password    |
 * | `GET`  | `/auth/get-session`  | Validate session token         |
 * | `POST` | `/auth/sign-out`     | End session                    |
 *
 * **Auth macro usage:**
 * ```typescript
 * app
 *   .use(createAuthPlugin({ database: db }))
 *   .get('/protected', ({ user }) => user, { auth: true });
 * ```
 *
 * **Bearer token support:**
 * Desktop and API clients send `Authorization: Bearer <token>` instead of cookies.
 * The Bearer plugin converts this to a session cookie internally.
 *
 * @example
 * ```typescript
 * import { Database } from 'bun:sqlite';
 *
 * const app = new Elysia()
 *   .use(createAuthPlugin({
 *     database: new Database('auth.db'),
 *     secret: 'remote-secret',
 *     trustedOrigins: ['tauri://localhost'],
 *   }))
 *   .get('/me', ({ user }) => user, { auth: true })
 *   .listen(3913);
 * ```
 */
export function createAuthPlugin(config: AuthPluginConfig) {
	const auth = createBetterAuth(config);

	return new Elysia({ name: 'better-auth' }).mount(auth.handler).macro({
		auth: {
			async resolve({ status, request: { headers } }) {
				const session = await auth.api.getSession({ headers });

				if (!session) return status(401);

				return {
					user: session.user,
					session: session.session,
				};
			},
		},
	});
}
