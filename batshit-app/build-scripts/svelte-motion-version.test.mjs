import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
const program = `const config = (await import('./build-scripts/sveltekit-options.mjs')).default;
console.log(JSON.stringify({ hasVersion: Object.hasOwn(config, 'version'),
  version: config.version?.name ?? null, adapter: config.adapter.name }));`

function inspect(version) {
  const env = { ...process.env, BATSHIT_SVELTE_ADAPTER: 'node' }
  delete env.BATSHIT_MOTION_KIT_VERSION
  if (version !== undefined) env.BATSHIT_MOTION_KIT_VERSION = version
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: app, env, encoding: 'utf8', timeout: 10_000
  })
}

test('unset Motion build version preserves Kit default and the selected adapter', () => {
  const result = inspect(undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { hasVersion: false, version: null, adapter: '@sveltejs/adapter-node' })
})
