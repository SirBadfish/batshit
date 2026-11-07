import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePath } from 'vite';

/** Development SSR uses Node's loader for the fixed shared CJS custody contract.
 * Production keeps Vite's existing CommonJS bundling. Restart the entire dev
 * process after editing the contract: Node's require cache does not provide HMR.
 * @returns {import('vite').Plugin}
 */
export function macCustodyDevPlugin() {
	const contracts = [
		{ source: '../../batshit-server/server/src/utils/macCustodyPaths.cjs', names: [] }
	].map(({ source, names }) => {
		const file = realpathSync(fileURLToPath(new URL(source, import.meta.url)));
		return { file, id: normalizePath(file), names };
	});
	return {
		name: 'batshit-mac-custody-dev',
		apply: 'serve',
		enforce: 'pre',
		load(id, options) {
			if (options?.ssr !== true) return null;
			const contract = contracts.find(entry => entry.id === id);
			if (!contract) return null;
			return `import { createRequire } from 'node:module';
const shared = createRequire(${JSON.stringify(pathToFileURL(contract.file).href)})(${JSON.stringify(contract.file)});
export default shared;
${contract.names.map(name => `export const ${name} = shared.${name};`).join('\n')}`;
		}
	};
}
