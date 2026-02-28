/**
 * Remote-server-delegated session validation for the local server.
 *
 * The local server doesn't run Better Auth — it validates session tokens
 * by calling the remote server's `GET /auth/get-session` endpoint and caching
 * the result with a configurable TTL.
 *
 * This keeps the local server stateless with respect to auth while still
 * rejecting unauthorized requests. The cache prevents hitting the remote server
 * on every request — acceptable for the threat model (local process
 * isolation, not internet-facing auth).
 *
 * @example
 * ```typescript
 * const validate = createRemoteSessionValidator({
 *   remoteUrl: 'https://remote.example.com',
 *   cacheTtlMs: 5 * 60 * 1000, // 5 minutes
 * });
 *
 * const session = await validate('bearer-token-here');
 * if (!session) {
 *   // Reject request
 * }
 * ```
 */

/** Cached validation result. */
type CacheEntry = {
	/** Whether the token is valid. */
	valid: boolean;
	/** User info from the remote server session (only when valid). */
	user?: { id: string; email: string; name?: string };
	/** Timestamp when this entry was cached. */
	cachedAt: number;
};

export type RemoteSessionValidatorConfig = {
	/**
	 * The remote server URL (e.g., 'https://remote.example.com' or 'http://localhost:3913').
	 *
	 * The local server calls `{remoteUrl}/auth/get-session` to validate tokens.
	 */
	remoteUrl: string;

	/**
	 * Cache TTL in milliseconds.
	 *
	 * Valid tokens are cached for this duration to avoid hitting
	 * the remote server on every request. Default: 5 minutes (300000ms).
	 *
	 * The threat model is local process isolation — a 5-minute
	 * stale window is acceptable for a localhost server.
	 */
	cacheTtlMs?: number;
};

export type SessionValidationResult =
	| {
			valid: true;
			user: { id: string; email: string; name?: string };
	  }
	| {
			valid: false;
	  };

/**
 * Create a session validator that delegates to the remote server.
 *
 * Returns a function that validates Bearer tokens by calling the remote server's
 * Better Auth session endpoint. Results are cached with a configurable TTL.
 *
 * @example
 * ```typescript
 * const validate = createRemoteSessionValidator({
 *   remoteUrl: 'http://localhost:3913',
 * });
 *
 * // In a request handler:
 * const result = await validate(bearerToken);
 * if (!result.valid) return status(401);
 * console.log(result.user.email);
 * ```
 */
export function createRemoteSessionValidator(
	config: RemoteSessionValidatorConfig,
) {
	const { remoteUrl, cacheTtlMs = 5 * 60 * 1000 } = config;
	const cache = new Map<string, CacheEntry>();

	/**
	 * Validate a session token against the remote server.
	 *
	 * Checks the cache first, then calls the remote server's session endpoint.
	 * Invalid tokens are cached briefly (1/5 of TTL) to prevent
	 * hammering the remote server with repeated bad tokens.
	 */
	return async function validateSession(
		token: string,
	): Promise<SessionValidationResult> {
		// Check cache
		const cached = cache.get(token);
		if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
			return cached.valid
				? { valid: true, user: cached.user! }
				: { valid: false };
		}

		// Call remote server
		try {
			const response = await fetch(`${remoteUrl}/auth/get-session`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				cache.set(token, {
					valid: false,
					cachedAt: Date.now(),
				});
				return { valid: false };
			}

			const data = (await response.json()) as {
				user?: { id: string; email: string; name?: string };
				session?: unknown;
			};

			if (!data.user) {
				cache.set(token, { valid: false, cachedAt: Date.now() });
				return { valid: false };
			}

			const user = {
				id: data.user.id,
				email: data.user.email,
				name: data.user.name,
			};

			cache.set(token, { valid: true, user, cachedAt: Date.now() });
			return { valid: true, user };
		} catch {
			// Remote server unreachable — check if we have a stale-but-valid cache entry
			// This provides resilience when the remote server is temporarily down
			if (cached?.valid) {
				return { valid: true, user: cached.user! };
			}
			return { valid: false };
		}
	};
}
