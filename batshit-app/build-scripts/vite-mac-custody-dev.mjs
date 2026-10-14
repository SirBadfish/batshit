import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePath } from 'vite';

/** Development SSR uses Node's loader for the one shared custody contract.
 * Production keeps Vite's existing CommonJS bundling. Restart the entire dev
 * process after editing the contract: Node's require cache does not provide HMR.
 * @returns {import('vite').Plugin}
 */
export function macCustodyDevPlugin() {
	const contractPath = realpathSync(fileURLToPath(new URL(
		'../../batshit-server/server/src/utils/macCustodyPaths.cjs', import.meta.url
	)));
	const contractId = normalizePath(contractPath);
	return {
		name: 'batshit-mac-custody-dev',
		apply: 'serve',
		enforce: 'pre',
		load(id, options) {
			if (options?.ssr !== true || id !== contractId) return null;
			return `import { createRequire } from 'node:module';
const custody = createRequire(${JSON.stringify(pathToFileURL(contractPath).href)})(${JSON.stringify(contractPath)});
export default custody;`;
		}
	};
}
