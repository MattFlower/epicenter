import type { KeyboardEventSupportedKey } from './browser/supported-keys';
import { isMouseToken } from './mouse';
import { FUNCTION_KEY_PATTERN } from './patterns';

/**
 * Display labels for browser keys that need human-readable representation.
 * Exhaustive mapping for all non-trivial keys.
 */
const BROWSER_KEY_DISPLAY_LABELS: Partial<
	Record<KeyboardEventSupportedKey, string>
> = {
	// Whitespace (PRIMARY FIX)
	' ': 'Space',
	enter: 'Enter',
	tab: 'Tab',

	// Modifiers
	control: 'Ctrl',
	shift: 'Shift',
	alt: 'Alt',
	meta: 'Cmd',
	altgraph: 'AltGr',
	capslock: 'CapsLock',
	numlock: 'NumLock',
	scrolllock: 'ScrollLock',
	fn: 'Fn',
	fnlock: 'FnLock',
	super: 'Super',

	// Navigation
	arrowleft: '←',
	arrowright: '→',
	arrowup: '↑',
	arrowdown: '↓',
	home: 'Home',
	end: 'End',
	pageup: 'PgUp',
	pagedown: 'PgDn',

	// Editing
	backspace: '⌫',
	delete: 'Del',
	insert: 'Ins',
	clear: 'Clear',
	copy: 'Copy',
	cut: 'Cut',
	paste: 'Paste',
	redo: 'Redo',
	undo: 'Undo',

	// Special
	escape: 'Esc',
	contextmenu: 'Menu',
	pause: 'Pause',
	break: 'Break',
	printscreen: 'PrtSc',
	help: 'Help',

	// Media
	mediaplaypause: 'Play/Pause',
	mediaplay: 'Play',
	mediapause: 'Pause',
	mediastop: 'Stop',
	mediatracknext: 'Next Track',
	mediatrackprevious: 'Prev Track',
	volumeup: 'Vol+',
	volumedown: 'Vol-',
	volumemute: 'Mute',

	// Other keys
	dead: 'Dead',
	compose: 'Compose',
	accept: 'Accept',
	again: 'Again',
	attn: 'Attn',
	cancel: 'Cancel',
	execute: 'Execute',
	find: 'Find',
	finish: 'Finish',
	props: 'Props',
	select: 'Select',
	zoomout: 'Zoom Out',
	zoomin: 'Zoom In',

	// Mouse buttons
	mouse0: 'Left Click',
	mouse1: 'Middle Click',
	mouse2: 'Right Click',
	mouse3: 'Mouse 4 (Back)',
	mouse4: 'Mouse 5 (Forward)',
	mouse5: 'Mouse 6',
	mouse6: 'Mouse 7',
	mouse7: 'Mouse 8',
	mouse8: 'Mouse 9',
	mouse9: 'Mouse 10',
	mouse10: 'Mouse 11',
	mouse11: 'Mouse 12',
	mouse12: 'Mouse 13',
	mouse13: 'Mouse 14',
	mouse14: 'Mouse 15',
	mouse15: 'Mouse 16',
	mouse16: 'Mouse 17',
	mouse17: 'Mouse 18',
	mouse18: 'Mouse 19',
	mouse19: 'Mouse 20',
};

/**
 * Gets display label for a full shortcut string.
 *
 * @param shortcut - The shortcut string (e.g., "control+shift+ ", "a")
 * @returns Human-readable display (e.g., "Ctrl + Shift + Space", "A")
 *
 * @example
 * getShortcutDisplayLabel(' ')           // 'Space'
 * getShortcutDisplayLabel('control+a')   // 'Ctrl + A'
 * getShortcutDisplayLabel(null)          // ''
 */
export function getShortcutDisplayLabel(shortcut: string | null): string {
	if (!shortcut) return '';

	return shortcut
		.split('+')
		.map((key) => formatKeyForDisplay(key.toLowerCase()))
		.join(' + ');
}

/**
 * Internal helper: formats a single key for display.
 */
function formatKeyForDisplay(key: string): string {
	const label = BROWSER_KEY_DISPLAY_LABELS[key as KeyboardEventSupportedKey];
	if (label) return label;

	// Mouse buttons not in the static map (e.g. mouse20+)
	if (isMouseToken(key)) {
		const num = Number(key.slice(5));
		return `Mouse ${num + 1}`;
	}

	// Single letters: uppercase
	if (key.length === 1 && key >= 'a' && key <= 'z') {
		return key.toUpperCase();
	}

	// Function keys: uppercase (f1 -> F1)
	if (FUNCTION_KEY_PATTERN.test(key)) {
		return key.toUpperCase();
	}

	// Fallback for unknown multi-char keys: capitalize first letter
	if (key.length > 1) {
		return key.charAt(0).toUpperCase() + key.slice(1);
	}

	// Single char non-letters (numbers, punctuation): return as-is
	return key;
}
