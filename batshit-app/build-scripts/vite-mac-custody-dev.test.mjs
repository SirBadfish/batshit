// Run from batshit-app: node --test build-scripts/vite-mac-custody-dev.test.mjs
// Real installed Vite, canonical app shim and unchanged CJS; no Redis or inference.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, createServer, loadConfigFromFile, normalizePath, resolveConfig } from 'vite';
import { macCustodyDevPlugin } from './vite-mac-custody-dev.mjs';

const appRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const configFile = path.join(appRoot, 'vite.config.ts');
const shim = path.join(appRoot, 'src/lib/server/services/macCustodyPaths.ts');
const contract = realpathSync(path.resolve(appRoot, '../batshit-server/server/src/utils/macCustodyPaths.cjs'));
const native = createRequire(import.meta.url)(contract);
const pluginName = macCustodyDevPlugin().name;

async function canonicalConfig(command = 'serve') {
	assert.equal(realpathSync(process.cwd()), appRoot, 'Run this regression from batshit-app.');
	const loaded = await loadConfigFromFile({ command, mode: command === 'serve' ? 'development' : 'production' }, configFile);
	assert.ok(loaded, 'Canonical Vite config must load.');
	return loaded.config;
}

/** Exercise native filesystem aliases with synthetic files only. */
async function assertCustody(custody) {
	const temp = await mkdtemp(path.join(os.tmpdir(), 'bl1085-custody-'));
	const root = await realpath(temp);
	try {
		const data = path.join(root, 'mac-data');
		const config = path.join(data, 'config');
		const project = path.join(root, 'project');
		const secret = path.join(config, 'runtime.env');
		await mkdir(config, { recursive: true });
		await mkdir(project);
		await writeFile(secret, 'synthetic-custody-sentinel');
		await symlink(config, path.join(project, 'directory-alias'));
		await symlink(secret, path.join(project, 'file-alias'));
		const environment = { BATSHIT_RUNTIME_OWNER: 'mac-app', BATSHIT_CONTAINERIZED: '0', BATSHIT_MAC_DATA_DIR: data };
		const denied = [config, secret, data, root, path.join(config, 'missing/child'),
			path.join(project, 'directory-alias'), path.join(project, 'directory-alias/missing'), path.join(project, 'file-alias')];
		const caseFile = path.join(data, 'CONFIG/RUNTIME.ENV');
		const caseAliasReadable = await readFile(caseFile, 'utf8').then(() => true, () => false);
		if (caseAliasReadable) {
			await symlink(caseFile, path.join(project, 'case-alias'));
			denied.push(path.dirname(caseFile), caseFile, path.join(project, 'case-alias'));
		}
		for (const candidate of denied) {
			assert.throws(() => custody.assertMacCustodyPathAllowed(candidate, environment), /credential storage is protected/);
			assert.throws(() => native.assertMacCustodyPathAllowed(candidate, environment), /credential storage is protected/);
		}
		assert.doesNotThrow(() => custody.assertMacCustodyPathAllowed(project, environment));
		assert.doesNotThrow(() => native.assertMacCustodyPathAllowed(project, environment));
		assert.deepEqual(custody.macCustodyRoots(environment), native.macCustodyRoots(environment));
		assert.equal(custody.resolveExistingPath(path.join(project, 'directory-alias/missing')), path.join(config, 'missing'));
		assert.throws(() => custody.macCustodyRoots({ ...environment, BATSHIT_MAC_DATA_DIR: 'relative' }), /absolute folder/);
		assert.throws(() => custody.assertMacCustodyPathAllowed(path.join(secret, 'child'), environment), /ENOTDIR/);
		return { denied: denied.length, caseAliasReadable };
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

test('development SSR: old loader fails, canonical repair loads the real guard', async (t) => {
	const config = await canonicalConfig();
	const plugins = (await Promise.all(config.plugins.flat(Infinity))).filter(Boolean);
	assert.equal(plugins.filter(plugin => plugin.name === pluginName).length, 1);
	// No listening HTTP/WebSocket server or watchers; only the real SSR runner.
	const isolated = { root: appRoot, configFile: false, envFile: false, appType: 'custom', logLevel: 'silent',
		server: { ...config.server, middlewareMode: true, ws: false, hmr: false, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] } };
	const before = await createServer({ ...config, ...isolated, plugins: plugins.filter(plugin => plugin.name !== pluginName) });
	try {
		await assert.rejects(before.ssrLoadModule(shim), /require is not defined/);
	} finally {
		await before.close();
	}
	const after = await createServer({ ...config, ...isolated });
	try {
		assert.equal(after.config.server.fs.strict, true);
		assert.deepEqual(after.config.server.fs.allow, before.config.server.fs.allow);
		const custody = await after.ssrLoadModule(shim);
		for (const name of ['macCustodyRoots', 'resolveExistingPath', 'assertMacCustodyPathAllowed']) {
			assert.equal(custody[name], native[name], `${name} must be the actual Node-loaded implementation.`);
		}
		t.diagnostic(JSON.stringify(await assertCustody(custody)));
		// An ordinary sibling app source module still passes through Vite normally.
		const sibling = await after.ssrLoadModule(path.join(appRoot, 'src/lib/utils/cliSubagentToolNames.ts'));
		assert.ok(Object.keys(sibling).length > 0);
	} finally {
		await after.close();
	}
});

test('bridge matches only the exact resolved file and only SSR development', async () => {
	const serve = await resolveConfig({ configFile, envFile: false }, 'serve');
	const production = await resolveConfig({ configFile, envFile: false }, 'build');
	assert.ok(serve.plugins.some(plugin => plugin.name === pluginName));
	assert.ok(!production.plugins.some(plugin => plugin.name === pluginName));
	assert.deepEqual(production.build.commonjsOptions.include, [/node_modules/, /macCustodyPaths\.cjs$/]);
	const plugin = macCustodyDevPlugin();
	const load = plugin.load;
	assert.equal(typeof load, 'function');
	const exact = normalizePath(contract);
	assert.equal(load(exact, { ssr: false }), null);
	assert.equal(load(exact), null);
	for (const id of [exact + '?raw', exact + '.other', path.join(appRoot, 'macCustodyPaths.cjs'), shim]) {
		assert.equal(load(id, { ssr: true }), null);
	}
	assert.match(load(exact, { ssr: true }), /createRequire/);
});

test('production: focused SSR bundle runs away from source with unchanged custody', async (t) => {
	const config = await canonicalConfig('build');
	const bundle = (plugins) => build({ root: appRoot, configFile: false, envFile: false, logLevel: 'silent',
		plugins,
		build: { ...config.build, ssr: shim, write: false, minify: false,
			rolldownOptions: { output: { format: 'es', codeSplitting: false } } } });
	const result = await bundle([macCustodyDevPlugin()]);
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(item => item.type === 'chunk');
	assert.equal(chunks.length, 1);
	const code = chunks[0].code;
	assert.ok(!code.includes(contract) && !code.includes(pathToFileURL(contract).href), 'No source-checkout path may escape into production.');
	// Rolldown itself uses createRequire for bundled Node builtins. Compare the
	// actual production bytes against the same build without our dev plugin.
	const baseline = await bundle([]);
	assert.ok(!Array.isArray(baseline) && 'output' in baseline);
	assert.equal(code, baseline.output.find(item => item.type === 'chunk').code, 'Production output must be unchanged.');
	const temp = await mkdtemp(path.join(os.tmpdir(), 'bl1085-bundle-'));
	try {
		const output = path.join(temp, 'custody.mjs');
		await writeFile(output, code);
		t.diagnostic(JSON.stringify(await assertCustody(await import(pathToFileURL(output).href))));
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
