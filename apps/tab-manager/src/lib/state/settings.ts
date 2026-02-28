/**
 * Server URL settings for the tab manager extension.
 *
 * Two URLs are maintained:
 * - **Server URL** (`serverUrl`): The local server for sync and workspace
 *   operations. Defaults to `http://127.0.0.1:3913`.
 * - **Remote Server URL** (`remoteServerUrl`): The remote server for AI, auth,
 *   and key management. Defaults to the same address — in single-server setups
 *   both point to the same place. For multi-server deployments, set this to the
 *   remote server's address (e.g., `https://hub.epicenter.so`).
 *
 * @example
 * ```typescript
 * const serverUrl = await getServerUrl();
 * const remoteUrl = await getRemoteServerUrl();
 * ```
 */

import { storage } from '@wxt-dev/storage';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3913';

/**
 * Local server URL storage item.
 *
 * Points to the local server for sync and workspace operations.
 * Defaults to localhost — the standard self-hosted server address.
 * Persisted in chrome.storage.local so it survives browser restarts.
 */
const serverUrlItem = storage.defineItem<string>('local:serverUrl', {
	fallback: DEFAULT_SERVER_URL,
});

/**
 * Remote server URL storage item.
 *
 * Points to the remote server for AI completions, authentication, and
 * API key management. Defaults to the same localhost address as the
 * local server — in single-server setups both URLs are identical.
 *
 * For multi-server deployments (e.g., Epicenter Cloud), set this to
 * the remote server's public address.
 */
const remoteServerUrlItem = storage.defineItem<string>(
	'local:remoteServerUrl',
	{
		fallback: DEFAULT_SERVER_URL,
	},
);

/**
 * Get the local server URL from chrome.storage.
 *
 * Returns the persisted URL, or the default `http://127.0.0.1:3913`
 * if none has been set.
 *
 * @example
 * ```typescript
 * const url = await getServerUrl();
 * fetch(`${url}/api/sync`);
 * ```
 */
export async function getServerUrl() {
	return serverUrlItem.getValue();
}

/**
 * Get the remote server URL from chrome.storage.
 *
 * Returns the persisted URL, or the default `http://127.0.0.1:3913`
 * if none has been set. The remote server handles AI completions,
 * authentication, and API key management.
 *
 * @example
 * ```typescript
 * const remoteUrl = await getRemoteServerUrl();
 * fetch(`${remoteUrl}/api/chat`);
 * ```
 */
export async function getRemoteServerUrl() {
	return remoteServerUrlItem.getValue();
}
