import { Elysia } from 'elysia';
import {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '../ai/adapters';

/**
 * Provider API base URLs.
 *
 * Maps each supported provider to its real API endpoint.
 * OpenCode sends requests to `/proxy/{provider}/*` on the remote server,
 * and the remote server forwards them to these URLs with the real API key.
 */
const PROVIDER_BASE_URLS: Partial<Record<SupportedProvider, string>> = {
	openai: 'https://api.openai.com',
	anthropic: 'https://api.anthropic.com',
	gemini: 'https://generativelanguage.googleapis.com',
	grok: 'https://api.x.ai',
};

export type ProxyPluginConfig = {
	/**
	 * Session validator function.
	 *
	 * Validates the Authorization header (which carries a session token,
	 * not an API key) before proxying the request.
	 *
	 * If not provided, the proxy does no auth validation (development only).
	 */
	validateSession?: (token: string) => Promise<{ valid: boolean }>;
};

/**
 * Create an Elysia plugin that provides provider-compatible reverse proxy endpoints.
 *
 * The proxy allows OpenCode instances to call LLM providers through the remote server
 * without having direct access to API keys. OpenCode sends requests to
 * `{remoteUrl}/proxy/{provider}/...` with a session token as the Authorization header.
 * The remote server validates the session, resolves the real API key from the operator's
 * environment variable, and forwards the request unchanged to the real provider API.
 *
 * Registers routes:
 *
 * | Method | Route                    | Description                        |
 * | ------ | ------------------------ | ---------------------------------- |
 * | `ALL`  | `/proxy/:provider/*`     | Reverse proxy to provider API      |
 *
 * @example
 * ```typescript
 * const app = new Elysia()
 *   .use(createProxyPlugin());
 *
 * // OpenCode calls: POST /proxy/anthropic/v1/messages
 * // Remote server: validates session → reads ANTHROPIC_API_KEY env var → forwards to api.anthropic.com/v1/messages
 * ```
 */
export function createProxyPlugin(config?: ProxyPluginConfig) {
	const validateSession = config?.validateSession;

	return new Elysia({ prefix: '/proxy' }).all(
		'/:provider/*',
		async ({ params, request, status }) => {
			const provider = params.provider;
			const path = params['*'];

			// Validate provider
			if (!isSupportedProvider(provider)) {
				return status('Bad Request', `Unsupported provider: ${provider}`);
			}

			const baseUrl = PROVIDER_BASE_URLS[provider];
			if (!baseUrl) {
				return status(
					'Bad Request',
					`Provider ${provider} does not support proxying (no external API)`,
				);
			}

			// Validate session token from Authorization header
			if (validateSession) {
				const authHeader = request.headers.get('authorization');
				const token = authHeader?.startsWith('Bearer ')
					? authHeader.slice(7)
					: undefined;

				if (!token) {
					return status('Unauthorized', 'Bearer token required');
				}

				const result = await validateSession(token);
				if (!result.valid) {
					return status('Unauthorized', 'Invalid session token');
				}
			}

			// Resolve the real API key from the operator's environment variable
			const envVarName = PROVIDER_ENV_VARS[provider];
			const apiKey = process.env[envVarName];
			if (!apiKey) {
				return status(
					'Bad Gateway',
					`No API key configured for ${provider}. Set ${envVarName} environment variable.`,
				);
			}

			// Build the forwarded request to the real provider API
			const targetUrl = `${baseUrl}/${path}`;

			// Clone headers, replacing Authorization with the real API key.
			// Different providers use different header formats:
			const forwardHeaders = new Headers(request.headers);

			// Remove the session token — it's not a valid API key
			forwardHeaders.delete('authorization');

			// Set the real API key in the provider-specific format
			if (provider === 'anthropic') {
				forwardHeaders.set('x-api-key', apiKey);
			} else {
				forwardHeaders.set('Authorization', `Bearer ${apiKey}`);
			}

			// Remove host header (will be set by fetch for the target domain)
			forwardHeaders.delete('host');

			// Forward the request unchanged
			const proxyResponse = await fetch(targetUrl, {
				method: request.method,
				headers: forwardHeaders,
				body: request.body,
			});

			// Stream the response back to OpenCode
			return new Response(proxyResponse.body, {
				status: proxyResponse.status,
				statusText: proxyResponse.statusText,
				headers: proxyResponse.headers,
			});
		},
	);
}
