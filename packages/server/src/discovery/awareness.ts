/**
 * Yjs Awareness-based server discovery.
 *
 * Devices discover each other by connecting to a shared discovery room
 * (`_epicenter_discovery`) on the remote server's sync layer. Each device sets
 * its local Awareness state with capabilities and connection info.
 *
 * No dedicated HTTP endpoints needed — discovery piggybacks on the
 * existing WebSocket sync infrastructure.
 *
 * @example
 * ```typescript
 * // On local server boot — broadcast presence to discovery room
 * import { WebsocketProvider } from '@epicenter/sync';
 *
 * const provider = new WebsocketProvider(remoteUrl, DISCOVERY_ROOM_ID, doc);
 * provider.awareness.setLocalState(createLocalPresence({
 *   url: 'http://192.168.1.100:3913',
 *   deviceId: 'device_abc123',
 *   hostname: "Braden's MacBook Pro",
 * }));
 *
 * // On any client — listen for device changes
 * provider.awareness.on('change', () => {
 *   const devices = getDiscoveredDevices(provider.awareness);
 * });
 * ```
 */

/**
 * The shared room ID used for device discovery.
 *
 * All devices connect to this room on the remote server's sync layer.
 * The room is created on demand (first connection) and
 * lives as long as any participant is connected.
 */
export const DISCOVERY_ROOM_ID = '_epicenter_discovery';

/**
 * Device types in the discovery network.
 *
 * - `local` — Desktop running a local server (sync + workspace)
 * - `client` — Browser extension, mobile app, or other thin client
 */
export type DeviceType = 'local' | 'client';

/**
 * Capabilities a device can advertise.
 *
 * Used by other devices to understand what each participant offers.
 * Local servers typically advertise `sync` and `workspace`.
 * Clients advertise nothing (they consume, not provide).
 */
export type DeviceCapability = 'sync' | 'workspace';

/**
 * Awareness state for a device in the discovery room.
 *
 * Set via `awareness.setLocalState(state)`. Other participants
 * receive this state in real-time via the Awareness protocol.
 *
 * When a device disconnects (graceful or crash), the Awareness
 * protocol automatically removes its state after ~30 seconds.
 */
export type DiscoveryState = {
	/** Device type (local or client). */
	type: DeviceType;

	/**
	 * Reachable URL for this device's server (local servers only).
	 *
	 * Other devices can use this to connect directly for fast local sync.
	 * Example: `http://192.168.1.100:3913`
	 */
	url?: string;

	/**
	 * Stable device identifier.
	 *
	 * Generated per-installation (nanoid). Used to distinguish
	 * devices in the UI. Not the same as the Awareness clientId
	 * (which changes per WebSocket connection).
	 */
	deviceId: string;

	/** What this device can provide to the network. */
	capabilities: DeviceCapability[];

	/**
	 * Human-readable hostname for display in the devices UI.
	 *
	 * Example: "Braden's MacBook Pro", "Home Server"
	 */
	hostname: string;
};

/**
 * Create an Awareness state for a local server device.
 *
 * Used when the local server boots and connects to the remote server's discovery room.
 *
 * @example
 * ```typescript
 * const state = createLocalPresence({
 *   url: 'http://192.168.1.100:3913',
 *   deviceId: 'device_abc123',
 *   hostname: "Braden's MacBook Pro",
 * });
 * awareness.setLocalState(state);
 * ```
 */
export function createLocalPresence(config: {
	url: string;
	deviceId: string;
	hostname: string;
}): DiscoveryState {
	return {
		type: 'local',
		url: config.url,
		deviceId: config.deviceId,
		capabilities: ['sync', 'workspace'],
		hostname: config.hostname,
	};
}

/**
 * Create an Awareness state for a client device (mobile, extension, etc.).
 *
 * Clients don't provide capabilities — they only consume.
 *
 * @example
 * ```typescript
 * const state = createClientPresence({
 *   deviceId: 'device_xyz789',
 *   hostname: "Braden's iPhone",
 * });
 * awareness.setLocalState(state);
 * ```
 */
export function createClientPresence(config: {
	deviceId: string;
	hostname: string;
}): DiscoveryState {
	return {
		type: 'client',
		deviceId: config.deviceId,
		capabilities: [],
		hostname: config.hostname,
	};
}

/**
 * Extract discovered devices from the Awareness state map.
 *
 * Filters the raw Awareness states to only include valid DiscoveryState
 * entries, deduplicating by deviceId (keeps the most recent if multiple
 * connections exist for the same device).
 *
 * @param states - The Awareness states map from `awareness.getStates()`
 * @returns Array of discovered device states
 *
 * @example
 * ```typescript
 * const devices = getDiscoveredDevices(awareness.getStates());
 * const localServers = devices.filter(d => d.type === 'local');
 * ```
 */
export function getDiscoveredDevices(
	states: Map<number, unknown>,
): DiscoveryState[] {
	const deviceMap = new Map<string, DiscoveryState>();

	for (const state of states.values()) {
		if (!isDiscoveryState(state)) continue;

		// Deduplicate by deviceId — keep any valid entry
		// (multiple connections from the same device will both appear
		// in Awareness with different clientIds, but same deviceId)
		deviceMap.set(state.deviceId, state);
	}

	return Array.from(deviceMap.values());
}

/**
 * Type guard for DiscoveryState.
 *
 * Validates that a raw Awareness state object has the expected shape.
 */
function isDiscoveryState(state: unknown): state is DiscoveryState {
	if (!state || typeof state !== 'object') return false;
	const s = state as Record<string, unknown>;
	return (
		(s.type === 'local' || s.type === 'client') &&
		typeof s.deviceId === 'string' &&
		Array.isArray(s.capabilities) &&
		typeof s.hostname === 'string'
	);
}
