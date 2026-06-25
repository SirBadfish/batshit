export const BATSHIT_SETTINGS_PANEL_OPEN_CLASS = 'batshit-settings-panel-open';
export const BATSHIT_TOAST_SCOPE_APP_CLASS = 'batshit-toast-scope-app';
export const BATSHIT_TOAST_SCOPE_SETTINGS_CLASS = 'batshit-toast-scope-settings';

const BATSHIT_TOAST_SCOPE_CLASSES = new Set([
	BATSHIT_TOAST_SCOPE_APP_CLASS,
	BATSHIT_TOAST_SCOPE_SETTINGS_CLASS
]);

export type BatshitToastScope = 'app' | 'settings';

function getScopeClass(scope: BatshitToastScope) {
	return scope === 'settings'
		? BATSHIT_TOAST_SCOPE_SETTINGS_CLASS
		: BATSHIT_TOAST_SCOPE_APP_CLASS;
}

export function mergeToastScopeClass(
	className: string | undefined,
	scope: BatshitToastScope
) {
	const tokens = new Set((className ?? '').split(/\s+/).filter(Boolean));
	for (const token of tokens) {
		if (BATSHIT_TOAST_SCOPE_CLASSES.has(token)) {
			return Array.from(tokens).join(' ');
		}
	}
	tokens.add(getScopeClass(scope));
	return Array.from(tokens).join(' ');
}

export function scopeToastOptions<T extends { class?: string } | undefined>(
	options: T,
	scope: BatshitToastScope
): T {
	if (!options) {
		return { class: mergeToastScopeClass(undefined, scope) } as T;
	}

	return {
		...options,
		class: mergeToastScopeClass(options.class, scope)
	} as T;
}
