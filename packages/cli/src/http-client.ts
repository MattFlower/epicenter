// packages/cli/src/http-client.ts

/** Minimal HTTP client with typed JSON responses and optional bearer-token auth. */
interface HttpClient {
	get: <T = unknown>(path: string) => Promise<T>;
	post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
	put: <T = unknown>(path: string, body?: unknown) => Promise<T>;
	patch: <T = unknown>(path: string, body?: unknown) => Promise<T>;
	delete: <T = unknown>(path: string) => Promise<T>;
}

/**
 * Create an HTTP client that prepends `baseUrl` to every request path.
 * Automatically sets Authorization and Content-Type headers as needed.
 * @param baseUrl - Base URL for all requests (e.g. `http://localhost:4649`).
 * @param token - Optional bearer token attached to every request.
 * @returns An {@link HttpClient} with get/post/put/patch/delete methods.
 */
export function createHttpClient(baseUrl: string, token?: string): HttpClient {
	async function request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const headers: Record<string, string> = {};
		if (token) headers['Authorization'] = `Bearer ${token}`;
		if (body !== undefined) headers['Content-Type'] = 'application/json';

		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
		}

		const contentType = response.headers.get('content-type');
		if (contentType?.includes('application/json')) {
			return response.json() as Promise<T>;
		}
		return response.text() as unknown as T;
	}

	return {
		get: <T = unknown>(path: string) => request<T>('GET', path),
		post: <T = unknown>(path: string, body?: unknown) =>
			request<T>('POST', path, body),
		put: <T = unknown>(path: string, body?: unknown) =>
			request<T>('PUT', path, body),
		patch: <T = unknown>(path: string, body?: unknown) =>
			request<T>('PATCH', path, body),
		delete: <T = unknown>(path: string) => request<T>('DELETE', path),
	};
}

/** Probe the server with a 2-second timeout. Throws a clear error if unreachable. */
export async function assertServerRunning(baseUrl: string): Promise<void> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		await fetch(baseUrl, { signal: controller.signal });
		clearTimeout(timeout);
	} catch {
		throw new Error(
			`Local server is not running at ${baseUrl}\nRun 'epicenter local start' to start the server.`,
		);
	}
}

export type { HttpClient };
