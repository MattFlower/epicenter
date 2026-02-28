export {
	createClientPresence,
	createLocalPresence,
	type DeviceCapability,
	type DeviceType,
	DISCOVERY_ROOM_ID,
	type DiscoveryState,
	getDiscoveredDevices,
} from './discovery';
export {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from './providers';
export { DEFAULT_PORT, listenWithFallback } from './server';
export { createSyncPlugin, type SyncPluginConfig } from './sync';
export { type AuthConfig } from './sync/auth';
