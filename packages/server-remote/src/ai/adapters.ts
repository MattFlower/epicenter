import { PROVIDER_ENV_VARS, type SupportedProvider } from '@epicenter/server';
import type { AnyTextAdapter } from '@tanstack/ai';
import {
	type AnthropicChatModel,
	createAnthropicChat,
} from '@tanstack/ai-anthropic';
import { createGeminiChat, type GeminiTextModel } from '@tanstack/ai-gemini';
import { createGrokText, type GrokChatModel } from '@tanstack/ai-grok';
import { createOpenaiChat, type OpenAIChatModel } from '@tanstack/ai-openai';

export {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from '@epicenter/server';

/**
 * Create a TanStack AI text adapter for the given provider.
 *
 * Uses the explicit-key variants (`createOpenaiChat`, `createAnthropicChat`, etc.)
 * instead of the env-auto-detect variants (`openaiText`, `anthropicText`) because
 * API keys are resolved server-side from env vars or per-request headers,
 * not auto-detected from conventional env var names.
 *
 * Model names come from the client as arbitrary strings. Invalid model names
 * will fail at the provider API level with a descriptive error — they won't
 * crash the server.
 *
 * API key presence is validated by the plugin layer before calling this,
 * so it receives a non-empty string.
 *
 * @returns The adapter instance, or `undefined` if the provider is not supported.
 */
export function createAdapter(
	provider: string,
	model: string,
	apiKey: string = '',
): AnyTextAdapter | undefined {
	switch (provider) {
		case 'openai':
			return createOpenaiChat(model as OpenAIChatModel, apiKey);
		case 'anthropic':
			return createAnthropicChat(model as AnthropicChatModel, apiKey);
		case 'gemini':
			return createGeminiChat(model as GeminiTextModel, apiKey);
		case 'grok':
			return createGrokText(model as GrokChatModel, apiKey);
		default:
			return undefined;
	}
}

/**
 * Resolve an API key for the given provider.
 *
 * Resolution chain:
 * 1. Per-request header key (x-provider-api-key) — BYOK, user's own billing
 * 2. Server environment variable — operator's key (set in `.env` or hosting dashboard)
 * 3. `undefined` (triggers 401)
 *
 * @param provider - The provider to resolve a key for
 * @param headerKey - Key from the x-provider-api-key request header
 */
export function resolveApiKey(
	provider: SupportedProvider,
	headerKey?: string,
): string | undefined {
	// 1. Per-request header (highest priority — BYOK)
	if (headerKey) return headerKey;

	// 2. Environment variable (operator key)
	const envVarName = PROVIDER_ENV_VARS[provider];
	return process.env[envVarName];
}
