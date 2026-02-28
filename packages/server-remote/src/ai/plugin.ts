import { chat, maxIterations, toServerSentEventsResponse } from '@tanstack/ai';
import { Elysia, t } from 'elysia';
import { Err, trySync } from 'wellcrafted/result';
import {
	createAdapter,
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	resolveApiKey,
} from './adapters';

/**
 * Creates an Elysia plugin that provides a generic streaming AI chat endpoint.
 *
 * Registers a single route:
 *
 * | Method | Route   | Description                                         |
 * | ------ | ------- | --------------------------------------------------- |
 * | `POST` | `/chat` | Streaming chat via SSE (Server-Sent Events)         |
 *
 * The client sends messages, provider name, and model. The server resolves
 * the API key, creates the appropriate TanStack AI adapter, calls `chat()`,
 * and streams the response back as SSE.
 *
 * This plugin runs on the remote server only — the SPA sends AI requests to
 * the remote server's `/ai/chat` endpoint, never to the local sidecar.
 *
 * This is a generic relay — no app-specific tools or system prompts are
 * baked in. Apps that need tools should run `chat()` client-side and use
 * the remote server's `/proxy/:provider/*` endpoint for operator-key API access.
 *
 * **API key resolution chain:**
 * 1. `x-provider-api-key` header (per-request BYOK — user's own billing)
 * 2. Environment variable (`OPENAI_API_KEY`, etc.) — operator's key
 *
 * All providers require an API key — there are no exceptions.
 *
 * @example
 * ```typescript
 * import { createAIPlugin } from '@epicenter/server/ai';
 *
 * const app = new Elysia()
 *   .use(new Elysia({ prefix: '/ai' }).use(createAIPlugin()))
 *   .listen(3913);
 * ```
 */
export function createAIPlugin() {
	return new Elysia().post(
		'/chat',
		async ({ body, headers, status }) => {
			const headerApiKey = headers['x-provider-api-key'];
			const {
				messages,
				provider,
				model,
				conversationId,
				systemPrompt,
				modelOptions,
				tools,
			} = body;

			if (!isSupportedProvider(provider)) {
				return status('Bad Request', `Unsupported provider: ${provider}`);
			}

			const apiKey = resolveApiKey(provider, headerApiKey);

			if (!apiKey) {
				const envVarName = PROVIDER_ENV_VARS[provider];
				return status(
					'Unauthorized',
					`Missing API key: set x-provider-api-key header or configure ${envVarName} environment variable`,
				);
			}

			const adapter = createAdapter(provider, model, apiKey);
			if (!adapter) {
				return status('Bad Request', `Unsupported provider: ${provider}`);
			}

			const abortController = new AbortController();

			const { data: stream, error: chatError } = trySync({
				try: () =>
					chat({
						adapter,
						messages,
						conversationId,
						abortController,
						agentLoopStrategy: maxIterations(10),
						systemPrompts: systemPrompt ? [systemPrompt] : [],
						tools,
						modelOptions,
					}),
				catch: (e) => Err(e instanceof Error ? e : new Error(String(e))),
			});

			if (chatError) {
				if (chatError.name === 'AbortError' || abortController.signal.aborted) {
					return status(499, 'Client closed request');
				}
				return status('Bad Gateway', `Provider error: ${chatError.message}`);
			}

			return toServerSentEventsResponse(stream, { abortController });
		},
		{
			body: t.Object({
				messages: t.Array(t.Any()),
				provider: t.String(),
				model: t.String(),
				conversationId: t.Optional(t.String()),
				systemPrompt: t.Optional(t.String()),
				modelOptions: t.Optional(t.Any()),
				tools: t.Optional(
					t.Array(
						t.Object({
							name: t.String(),
							description: t.String(),
							inputSchema: t.Optional(t.Any()),
						}),
					),
				),
			}),
			response: {
				400: t.String(),
				401: t.String(),
				499: t.String(),
				502: t.String(),
			},
		},
	);
}
