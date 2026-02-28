/** Pattern matching mouse button tokens like `mouse0`, `mouse3`, `mouse19` */
const MOUSE_TOKEN_PATTERN = /^mouse\d+$/;

/** Checks whether a string is a mouse button token (e.g. `"mouse3"`). */
export function isMouseToken(token: string): boolean {
	return MOUSE_TOKEN_PATTERN.test(token);
}

/** Converts a `MouseEvent.button` number to a token string (e.g. `3` → `"mouse3"`). */
export function mouseButtonToToken(button: number): string {
	return `mouse${button}`;
}

/** Extracts the button number from a mouse token, or `null` if the token is invalid. */
export function tokenToMouseButton(token: string): number | null {
	if (!isMouseToken(token)) return null;
	return Number(token.slice(5));
}

/** Returns `true` if any token in a `+`-delimited shortcut string is a mouse button. */
export function shortcutContainsMouse(shortcut: string): boolean {
	return shortcut.split('+').some(isMouseToken);
}
