/**
 * Shared provider constants used by both remote and local servers.
 *
 * The remote server uses these for AI streaming, adapter creation, and proxying.
 * The local server uses these for OpenCode config generation (routing through
 * the remote server's proxy).
 */

/**
 * Providers supported by the AI plugin.
 *
 * This is the source of truth — `SupportedProvider` is derived from this array.
 * Adding a new provider here automatically extends the type.
 */
export const SUPPORTED_PROVIDERS = [
	'openai',
	'anthropic',
	'gemini',
	'grok',
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Type guard for narrowing an arbitrary string to a known provider. */
export function isSupportedProvider(
	provider: string,
): provider is SupportedProvider {
	return SUPPORTED_PROVIDERS.includes(provider as SupportedProvider);
}

/** Environment variable names for each provider's API key. */
export const PROVIDER_ENV_VARS: Record<SupportedProvider, string> = {
	openai: 'OPENAI_API_KEY',
	anthropic: 'ANTHROPIC_API_KEY',
	gemini: 'GEMINI_API_KEY',
	grok: 'GROK_API_KEY',
};
