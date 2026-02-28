/** @module @epicenter/cli — Public API for the Epicenter CLI package. */

export { createCLI } from './cli';
export {
	type AnyWorkspaceClient,
	type DiscoveredWorkspace,
	discoverWorkspaces,
	resolveWorkspace,
	type WorkspaceResolution,
} from './discovery';
export { createHttpClient, type HttpClient } from './http-client';
export { cacheDir, resolveEpicenterHome, workspacesDir } from './paths';
