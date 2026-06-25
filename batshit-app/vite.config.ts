import { realpathSync } from 'node:fs';
import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const workspaceRoot = searchForWorkspaceRoot(process.cwd());
const configuredDevPort = Number(process.env.BATSHIT_FRONTEND_PORT || process.env.VITE_DEV_PORT || 5620);
const configuredDevHost = process.env.BATSHIT_FRONTEND_HOST || process.env.VITE_DEV_HOST || '127.0.0.1';
const hasConfiguredDevPort = Number.isInteger(configuredDevPort) && configuredDevPort > 0;
const shouldForwardBrowserConsole = process.env.BATSHIT_FORWARD_BROWSER_CONSOLE === '1';
const shouldInlineAsset = (filePath: string) => {
	const normalized = filePath.replace(/\\/g, '/');
	if (normalized.endsWith('/lip-sync-engine/dist/worker.js')) return false;
	return undefined;
};

const sharedNodeModulesPath = (() => {
	try {
		return realpathSync(path.resolve(process.cwd(), 'node_modules'));
	} catch {
		return path.resolve(process.cwd(), 'node_modules');
	}
})();

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	build: {
		assetsInlineLimit: shouldInlineAsset
	},
	server: {
		host: configuredDevHost,
		...(hasConfiguredDevPort
			? {
					port: configuredDevPort,
					strictPort: process.env.BATSHIT_STRICT_PORT === '1'
				}
			: {}),
		...(shouldForwardBrowserConsole
			? {
					forwardConsole: {
						unhandledErrors: true,
						logLevels: ['error', 'warn', 'info', 'log', 'debug']
					}
				}
			: {}),
		fs: {
			allow: [workspaceRoot, sharedNodeModulesPath]
		}
	}
});
