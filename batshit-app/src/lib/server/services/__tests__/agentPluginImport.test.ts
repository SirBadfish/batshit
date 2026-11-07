import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zipSync } from 'fflate/node'
import { execFileSync } from 'node:child_process'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
let scratch: string, source: string, home: string
async function zipFixture() {
  const entries: Record<string, Uint8Array> = {}
  const symlinks: string[] = []
  async function walk(dir: string, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), local = prefix + entry.name
      if (entry.isDirectory()) await walk(full, local + '/')
      else if (entry.isSymbolicLink()) { entries[local] = Buffer.from(await fs.readlink(full)); symlinks.push(local) }
      else entries[local] = await fs.readFile(full)
    }
  }
  await walk(source)
  const bytes = Buffer.from(zipSync(entries))
  for (let i = 0; i + 46 < bytes.length; i++) if (bytes.readUInt32LE(i) === 0x02014b50) {
    const name = bytes.subarray(i + 46, i + 46 + bytes.readUInt16LE(i + 28)).toString()
    if (symlinks.includes(name)) bytes.writeUInt32LE((0xa1ff << 16) >>> 0, i + 38)
  }
  const zip = path.join(scratch, 'plugin.zip'); await fs.writeFile(zip, bytes); return zip
}
async function put(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
async function packageFixture() {
  await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', version: '1.0.0', description: 'Fixture skills.' }))
  await put(path.join(source, 'skills/inspect/SKILL.md'), '---\nname: inspect\ndescription: Inspect the supplied fixture.\n---\n\nRead references/facts.md.\n')
  await put(path.join(source, 'skills/inspect/references/facts.md'), 'Supplied fixture facts.\n')
}

describe('skills-only complete plugin import', () => {
  useRedisTestServer()
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-plugin-import-'))
    source = path.join(scratch, 'source')
    home = path.join(scratch, 'home')
    vi.stubEnv('BATSHIT_HOME_DIR', home)
    vi.resetModules()
    await packageFixture()
  })
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(scratch, { recursive: true, force: true }) })

  it('captures complete references and mediated scripts without executing them', async () => {
    await put(path.join(source, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture.tools', skills: './skills/' }))
    await put(path.join(source, 'skills/inspect/scripts/never-run.js'), 'throw new Error("must not execute at import");')
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    const prepared = await prepareAgentPlugin(await zipFixture())
    expect(prepared.id).toBe('fixture.tools')
    expect(prepared.skills[0].definition.trustLevel).toBe('untrusted')
    expect(prepared.skills[0].definition.hasScripts).toBe(true)
    const reference = prepared.skills[0].definition.bundleFiles?.find(file => file.path === 'references/facts.md')
    expect(Buffer.from(reference!.content, 'base64').toString()).toBe('Supplied fixture facts.\n')
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['mcp.json', '.mcp.json', 'hooks/start.sh', 'commands/run.md', 'bin/install', 'assets/shared.png'])('refuses executable component %s before writing', async component => {
    await put(path.join(source, component), '{}')
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow(/Unsupported plugin/)
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an executable client manifest extension', async () => {
    await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', extensions: { 'com.example': { hooks: 'start.sh' } } }))
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow('Client extensions are not supported')
  })

  it('accepts inert OpenAI presentation metadata and still refuses executable extension fields', async () => {
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', extensions: { 'com.openai': { interface: { displayName: 'Fixture Tools' } } } }))
    expect((await prepareAgentPlugin(await zipFixture())).warnings).toContain('Client-specific presentation metadata is ignored; Batshit imports the included skills.')
    await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', extensions: { 'com.openai': { interface: { displayName: 'Fixture Tools' }, hooks: './hooks.json' } } }))
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow('Client extensions are not supported')
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a ZIP symlink without reading its target', async () => {
    const outside = path.join(scratch, 'outside.txt')
    await put(outside, 'outside bytes')
    await fs.symlink(outside, path.join(source, 'skills/inspect/references/escape.md'))
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow(/symlinks/)
  })

  it('refuses a mismatched skill identity instead of partially admitting siblings', async () => {
    await put(path.join(source, 'skills/wrong/SKILL.md'), '---\nname: other\ndescription: Other skill.\n---\nBody.')
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow('same name as its folder')
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports ignored unknown portable metadata and never treats it as executable configuration', async () => {
    await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', futureMetadata: 'display only' }))
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    expect((await prepareAgentPlugin(await zipFixture())).warnings).toContain('Ignored unknown manifest field: futureMetadata.')
  })

  it('refuses unsafe archive paths and corrupted file bytes before saving', async () => {
    const { readPluginArchive } = await import('../agentPluginArchive')
    expect(() => readPluginArchive(Buffer.from(zipSync({ '../plugin.json': Buffer.from('{}') })))).toThrow('unsafe or duplicate path')
    const bytes = await fs.readFile(await zipFixture())
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE((bytes.readUInt32LE(directory + 16) ^ 1) >>> 0, directory + 16)
    expect(() => readPluginArchive(bytes)).toThrow('integrity check')
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an inflated entry beyond the declared inventory', async () => {
    const { readPluginArchive } = await import('../agentPluginArchive')
    const bytes = await fs.readFile(await zipFixture())
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(0, directory + 24)
    expect(() => readPluginArchive(bytes)).toThrow(/declared size|integrity/)
  })

  it('refuses paths that would overwrite one another on case-insensitive filesystems', async () => {
    const { readPluginArchive } = await import('../agentPluginArchive')
    const bytes = Buffer.from(zipSync({ 'skills/inspect/references/Facts.md': Buffer.from('first'), 'skills/inspect/references/facts.md': Buffer.from('second') }))
    expect(() => readPluginArchive(bytes)).toThrow('collide on a supported filesystem')
  })

  it('rejects unknown author fields under the standard metadata contract', async () => {
    await put(path.join(source, 'plugin.json'), JSON.stringify({ $schema: schema, name: 'fixture.tools', author: { shell: 'ignored would be wrong' } }))
    const { prepareAgentPlugin } = await import('../agentPluginImport')
    await expect(prepareAgentPlugin(await zipFixture())).rejects.toThrow('author metadata is invalid')
  })

  it.skipIf(process.platform === 'win32')('refuses a local ZIP FIFO without waiting for a writer', async () => {
    const fifo = path.join(scratch, 'pipe.zip')
    execFileSync('mkfifo', [fifo])
    const { capturePluginArchiveFiles } = await import('../agentPluginArchive')
    await expect(capturePluginArchiveFiles(fifo)).rejects.toThrow('regular')
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('imports off with unique identities, refuses replacement, and removes only owned copies', async () => {
    const { importAgentPlugin, uninstallAgentPlugin } = await import('../agentPluginImport')
    const { getAgentPlugin } = await import('../agentPlugins')
    const { redis } = await import('$lib/server/redis')
    const { POST } = await import('../../../../routes/api/plugins/import/+server')
    const response = await POST({ locals: { user: { id: 'plugin_fixture_user' } }, request: new Request('http://127.0.0.1/api/plugins/import', {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(await fs.readFile(await zipFixture())).buffer
    }) } as any)
    expect(response.status).toBe(201)
    const { plugin } = await response.json()
    expect(plugin.enabled_for_all_agents).toBe(false)
    expect(plugin.enabled_agent_ids).toEqual([])
    expect(plugin.skills[0].invocation).toBe('/fixture.tools:inspect')
    expect(plugin.skills[0].commandId).not.toBe('inspect')
    const copied = path.join(home, 'skills', plugin.skills[0].skillId, 'references/facts.md')
    expect(await fs.readFile(copied, 'utf8')).toBe('Supplied fixture facts.\n')
    await expect(importAgentPlugin('plugin_fixture_user', await zipFixture())).rejects.toThrow('already installed')
    await uninstallAgentPlugin('plugin_fixture_user', plugin.id, plugin.revision)
    expect(await getAgentPlugin('plugin_fixture_user', plugin.id)).toBeNull()
    expect(await redis.json.get(`skill:plugin_fixture_user:${plugin.skills[0].skillId}`)).toBeNull()
    await expect(fs.stat(copied)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(source, 'skills/inspect/references/facts.md'), 'utf8')).toBe('Supplied fixture facts.\n')
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('rejects an existing namespaced invocation before creating plugin state', async () => {
    const { redis } = await import('$lib/server/redis')
    await redis.json.set('slash_command:plugin_fixture_user:existing', '$', { id: 'existing', user_id: 'plugin_fixture_user', type: 'prompt', invocation_pattern: '/fixture.tools:inspect' })
    const { importAgentPlugin } = await import('../agentPluginImport')
    const { getAgentPlugin } = await import('../agentPlugins')
    await expect(importAgentPlugin('plugin_fixture_user', await zipFixture())).rejects.toThrow('already uses')
    expect(await getAgentPlugin('plugin_fixture_user', 'fixture.tools')).toBeNull()
    await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('retains an interrupted import as off and removable without breaking other capabilities', async () => {
    const { importAgentPlugin, uninstallAgentPlugin } = await import('../agentPluginImport')
    const { getAgentPlugin } = await import('../agentPlugins')
    const { redis } = await import('$lib/server/redis')
    await redis.json.set('slash_command:plugin_fixture_user:existing', '$', { id: 'existing', user_id: 'plugin_fixture_user', name: 'Existing', type: 'prompt', enabled_for_all_agents: true })
    const archive = await zipFixture()
    const mkdir = fs.mkdir.bind(fs)
    const failure = vi.spyOn(fs, 'mkdir').mockImplementation(async (directory, options) => {
      if (String(directory).includes(`${home}/skills/plugin_`)) throw new Error('Fixture interrupted import')
      return mkdir(directory, options as any)
    })
    await expect(importAgentPlugin('plugin_fixture_user', archive)).rejects.toThrow('interrupted import')
    failure.mockRestore()
    const pending = await getAgentPlugin('plugin_fixture_user', 'fixture.tools')
    expect(pending?.installing).toBe(true)
    expect(pending?.enabled_for_all_agents).toBe(false)
    const { getEnabledAgentSlashCapabilities } = await import('../slashCommandCapabilities')
    expect((await getEnabledAgentSlashCapabilities('plugin_fixture_user', 'subject')).map(row => row.id)).toContain('existing')
    await uninstallAgentPlugin('plugin_fixture_user', pending!.id, pending!.revision)
    expect(await getAgentPlugin('plugin_fixture_user', 'fixture.tools')).toBeNull()
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('preserves unexpected files, retains removal custody, and completes a deliberate retry', async () => {
    const { importAgentPlugin, uninstallAgentPlugin } = await import('../agentPluginImport')
    const { getAgentPlugin, setAgentPluginGlobalAccess } = await import('../agentPlugins')
    const { plugin } = await importAgentPlugin('plugin_fixture_user', await zipFixture())
    const marker = path.join(home, 'skills', plugin.skills[0].skillId, '.plugin-import-owner')
    await fs.writeFile(marker, 'foreign')
    await expect(uninstallAgentPlugin('plugin_fixture_user', plugin.id, plugin.revision)).rejects.toThrow('ownership')
    const removing = (await getAgentPlugin('plugin_fixture_user', plugin.id))!
    expect(removing.removing).toBe(true)
    await expect(setAgentPluginGlobalAccess('plugin_fixture_user', plugin.id, true)).rejects.toThrow(/remov/)
    expect(await fs.readFile(marker, 'utf8')).toBe('foreign')
    await fs.writeFile(marker, plugin.id)
    await uninstallAgentPlugin('plugin_fixture_user', plugin.id, removing.revision)
    expect(await getAgentPlugin('plugin_fixture_user', plugin.id)).toBeNull()
  })

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('serializes duplicate physical removal and drains it before a restore boundary', async () => {
    const { importAgentPlugin, uninstallAgentPlugin } = await import('../agentPluginImport')
    const { getAgentPlugin } = await import('../agentPlugins')
    const { withSettingsRestoreFence } = await import('../appActions/settings/lifecycle')
    const { plugin } = await importAgentPlugin('plugin_fixture_user', await zipFixture())
    const folder = path.join(home, 'skills', plugin.skills[0].skillId)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(done => { release = done })
    const reached = new Promise<void>(done => { entered = done })
    const remove = fs.rm.bind(fs)
    const barrier = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === folder) { entered(); await held }
      return remove(target, options)
    })
    const removing = uninstallAgentPlugin('plugin_fixture_user', plugin.id, plugin.revision).then(() => null, error => error)
    await reached
    await expect(uninstallAgentPlugin('plugin_fixture_user', plugin.id, plugin.revision)).rejects.toThrow(/already being replaced/)
    let restored = false
    const restoring = withSettingsRestoreFence(async () => { restored = true })
    expect(restored).toBe(false)
    release()
    expect(await removing).toBeInstanceOf(Error)
    await restoring
    expect(restored).toBe(true)
    barrier.mockRestore()
    const pending = (await getAgentPlugin('plugin_fixture_user', plugin.id))!
    expect(pending.removing).toBe(true)
    await uninstallAgentPlugin('plugin_fixture_user', plugin.id, pending.revision)
    expect(await getAgentPlugin('plugin_fixture_user', plugin.id)).toBeNull()
  })
})
