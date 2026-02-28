// packages/cli/src/auth-store.ts
import { join } from 'node:path';

/** Persisted authentication credentials and user info for a remote server. */
interface AuthState {
	remoteUrl: string;
	token: string;
	expiresAt: string;
	user?: { id: string; email: string; name?: string };
}

/**
 * Resolve the path to the auth credentials file.
 * @param home - Epicenter home directory (e.g. `~/.epicenter`).
 */
export function authFilePath(home: string): string {
	return join(home, 'auth.json');
}

/**
 * Load saved auth credentials from disk.
 * @param home - Epicenter home directory.
 * @returns The stored {@link AuthState}, or `null` if no credentials exist.
 */
export async function loadAuth(home: string): Promise<AuthState | null> {
	const file = Bun.file(authFilePath(home));
	if (!(await file.exists())) return null;
	return file.json() as Promise<AuthState>;
}

/**
 * Persist auth credentials to disk as formatted JSON.
 * @param home - Epicenter home directory.
 * @param state - Auth state to write.
 */
export async function saveAuth(home: string, state: AuthState): Promise<void> {
	await Bun.write(authFilePath(home), JSON.stringify(state, null, 2));
}

/**
 * Delete the stored auth credentials file. No-op if the file doesn't exist.
 * @param home - Epicenter home directory.
 */
export async function clearAuth(home: string): Promise<void> {
	const { unlink } = await import('node:fs/promises');
	try {
		await unlink(authFilePath(home));
	} catch {}
}

export type { AuthState };
