import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Ok, type Result } from 'wellcrafted/result';
import type { ShortcutEventState } from '$lib/commands';
import { mouseButtonToToken } from '$lib/constants/keyboard';

/** Payload shape emitted by the Rust `global_mouse` module. */
interface GlobalMouseEventPayload {
	button: number;
	modifiers: string[];
	state: 'Pressed' | 'Released';
}

interface Registration {
	tokens: string[];
	callback: (state: ShortcutEventState) => void;
	on: ShortcutEventState[];
}

/** Set of shortcuts that have already fired and must be released before re-firing. */
const activeShortcuts = new Set<string>();

const registrations = new Map<string, Registration>();

let unlistenFn: UnlistenFn | null = null;

function arraysMatch(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((k) => b.includes(k));
}

function parseShortcutTokens(shortcut: string): string[] {
	return shortcut.split('+').map((t) => t.toLowerCase());
}

async function ensureListener(): Promise<void> {
	if (unlistenFn) return;

	unlistenFn = await listen<GlobalMouseEventPayload>(
		'global-mouse-event',
		(event) => {
			const { button, modifiers, state } = event.payload;
			const currentTokens = [
				...modifiers,
				mouseButtonToToken(button),
			];

			for (const [shortcutString, reg] of registrations.entries()) {
				if (!arraysMatch(currentTokens, reg.tokens)) continue;

				if (state === 'Pressed' && reg.on.includes('Pressed')) {
					if (!activeShortcuts.has(shortcutString)) {
						activeShortcuts.add(shortcutString);
						reg.callback('Pressed');
					}
				}

				if (state === 'Released') {
					if (activeShortcuts.has(shortcutString)) {
						activeShortcuts.delete(shortcutString);
						if (reg.on.includes('Released')) {
							reg.callback('Released');
						}
					}
				}
			}
		},
	);
}

function maybeStopListener(): void {
	if (registrations.size === 0 && unlistenFn) {
		unlistenFn();
		unlistenFn = null;
	}
}

export const GlobalMouseShortcutManagerLive = {
	async register({
		shortcutString,
		callback,
		on,
	}: {
		shortcutString: string;
		callback: (state: ShortcutEventState) => void;
		on: ShortcutEventState[];
	}): Promise<Result<void, never>> {
		// Unregister first (idempotent)
		registrations.delete(shortcutString);
		activeShortcuts.delete(shortcutString);

		registrations.set(shortcutString, {
			tokens: parseShortcutTokens(shortcutString),
			callback,
			on,
		});

		await ensureListener();
		return Ok(undefined);
	},

	async unregister(
		shortcutString: string,
	): Promise<Result<void, never>> {
		registrations.delete(shortcutString);
		activeShortcuts.delete(shortcutString);
		maybeStopListener();
		return Ok(undefined);
	},

	async unregisterAll(): Promise<Result<void, never>> {
		registrations.clear();
		activeShortcuts.clear();
		maybeStopListener();
		return Ok(undefined);
	},
};

export type GlobalMouseShortcutManager =
	typeof GlobalMouseShortcutManagerLive;
