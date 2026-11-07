// @vitest-environment node
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const testHome = vi.hoisted(() => ({ directory: '', old: process.env.BATSHIT_HOME_DIR }))
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  const nodePath = await import('node:path')
  testHome.directory = nodePath.join(actual.tmpdir(), `batshit-app-actions-collision-${process.pid}-${Date.now()}`)
  process.env.BATSHIT_HOME_DIR = nodePath.join(testHome.directory, '.batshit')
  const homedir = () => testHome.directory
  return { ...actual, homedir, default: { ...actual, homedir } }
})
// Force the named/default home mock before a registry module could capture its root.
import os from 'node:os'
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { useAppActionsSkillPublicationTwin } from '$lib/test-utils/appActionsSkillPublicationTwin'
import { getBatshitHomeDir } from '../batshitHome'
import { upsertSkill, getSkill, type UpsertSkillInput } from '../skillRegistry'
import { getBuiltinSystemSkillsRoot } from '../systemPluginPackage'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, saveSlashCommandRecord } from '../slashCommandRevision'
import type { SlashCommandRow } from '$lib/types/database'

const admission = useSkillSessionRedisTestServer()
useAppActionsSkillPublicationTwin()
const USER = 'app-collision-owner'
const KEY = `skill:${USER}:app_actions`
const COMMAND_KEY = `slash_command:${USER}:app-actions`
const localFile = () => path.join(testHome.directory, '.batshit/skills/app_actions/SKILL.md')
const custom = (markdown = '# User-owned instructions'): UpsertSkillInput => ({ userId: USER, commandId: 'app-actions',
  skill: { id: 'app_actions', name: 'app-actions', markdown, source: 'custom', isSystem: false, bundleFiles: [] } })
const seed = (): UpsertSkillInput => ({ userId: USER, commandId: 'app-actions', builtinAppActionsSeed: true,
  skill: { id: 'app_actions', name: 'app-actions', source: 'system', isSystem: true, sourceRef: path.join(getBuiltinSystemSkillsRoot(), 'app-actions') } })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function pausePublication(source: 'custom' | 'system') {
  const entered = deferred(), release = deferred()
  const original = redis.execute
  let paused = false
  vi.spyOn(redis, 'execute').mockImplementation(operation => original.call(redis, client => operation(new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'eval') return async (script: string, options: { keys: string[]; arguments: string[] }) => {
        if (!paused && script.startsWith('\n-- BATSHIT_APP_ACTIONS_SKILL_PUBLICATION_V1\n') && JSON.parse(options.arguments[2]).source === source) {
          paused = true; entered.resolve(); await release.promise
        }
        return client.eval(script, options)
      }
      const value = Reflect.get(client, property, client)
      return typeof value === 'function' ? value.bind(client) : value
    }
  }))))
  return { entered, release }
}
async function publishCommand(canonical: boolean) {
  const command: SlashCommandRow = { id: 'app-actions', user_id: USER, name: 'app-actions', type: canonical ? 'skill' : 'prompt',
    is_active: true, can_be_invoked_in_chat: true, enabled_for_all_agents: false, enabled_agent_ids: [], created_at: 'original', updated_at: 'original',
    ...(canonical ? { skill_id: 'app_actions', plugin_id: 'batshit', is_system: true, skill_source: 'system' } : { instructions: 'Original user-owned prompt' }) }
  if (process.env.VITEST_USE_REAL_REDIS === 'true') {
    // Actual existing command-save owner; its catalogue CAS does not replace Settings state.
    const basis = await captureSlashCommandWriteBasis(beginSlashCommandWrite(USER), ['app-actions'])
    expect(await saveSlashCommandRecord(USER, { record: command, mode: 'create' }, basis)).toMatchObject(command)
  } else {
    // Default lane proves the two-key guard against the saved shape, not the command Lua.
    await redis.json.set(COMMAND_KEY, '$', command)
    await redis.execute(client => client.set(`slash_command_revision:${USER}`, 'a'.repeat(64)))
  }
  return redis.json.getRaw(COMMAND_KEY, '$')
}
beforeEach(async () => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') admission.requireAdmission()
  expect(os.homedir()).toBe(testHome.directory)
  expect(getBatshitHomeDir()).toBe(path.join(testHome.directory, '.batshit'))
  await fs.rm(testHome.directory, { recursive: true, force: true })
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await fs.rm(testHome.directory, { recursive: true, force: true })
  if (testHome.old === undefined) delete process.env.BATSHIT_HOME_DIR
  else process.env.BATSHIT_HOME_DIR = testHome.old
})

describe('new App Actions namespace preserves an existing user skill', () => {
  it('refuses seed over custom metadata before materialization and keeps user bytes and grants', async () => {
    await upsertSkill(custom())
    await redis.json.set(KEY, '$.unknownAccess', { ids: ['Original.Agent'] })
    const before = await redis.json.getRaw(KEY, '$'), text = await fs.readFile(localFile(), 'utf8')
    await expect(upsertSkill(seed())).rejects.toThrow('owned by another saved skill')
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    expect(await fs.readFile(localFile(), 'utf8')).toBe(text)
    expect((await getSkill(USER, 'app_actions'))?.skill_markdown).toBe(text)
  })

  it('refuses custom save over a positively owned canonical skill before creating a user folder', async () => {
    await upsertSkill(seed())
    const before = await redis.json.getRaw(KEY, '$')
    await expect(upsertSkill(custom())).rejects.toThrow('owned by another saved skill')
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    await expect(fs.access(localFile())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a canonical command still reserves its missing backing skill, while a user prompt blocks system seeding', async () => {
    const commandKey = `slash_command:${USER}:app-actions`
    await redis.json.set(commandKey, '$', { id: 'app-actions', user_id: USER, type: 'skill', skill_id: 'app_actions', plugin_id: 'batshit', is_system: true, skill_source: 'system' })
    await expect(upsertSkill(custom())).rejects.toThrow('command ID is owned')
    expect(await redis.json.get(KEY)).toBeNull()
    await expect(fs.access(localFile())).rejects.toMatchObject({ code: 'ENOENT' })
    await redis.json.set(commandKey, '$', { id: 'app-actions', user_id: USER, type: 'prompt', instructions: 'Original prompt' })
    await expect(upsertSkill(seed())).rejects.toThrow('command ID is owned')
    expect(await redis.json.get(KEY)).toBeNull()
  })

  it.each(['custom', 'system'] as const)('CAS-refuses a stale %s publication when the opposite owner wins first; keeps user files', async (waiting) => {
    const { entered, release } = pausePublication(waiting)
    const first = upsertSkill(waiting === 'custom' ? custom('# Preserved user draft') : seed())
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('Publication settled before the intended boundary.') })])
      const winner = await upsertSkill(waiting === 'custom' ? seed() : custom('# Preserved user winner'))
      release.resolve()
      await expect(first).rejects.toThrow('identity changed')
      expect((await redis.json.get(KEY) as any).source).toBe(winner.source)
      expect(await fs.readFile(localFile(), 'utf8')).toBe(waiting === 'custom' ? '# Preserved user draft' : '# Preserved user winner')
    } finally { release.resolve() }
  })

  it.each(['custom', 'system'] as const)('refuses a stale %s publication when only the opposite command owner wins at physical issue', async waiting => {
    const { entered, release } = pausePublication(waiting)
    const before = await redis.json.getRaw(KEY, '$')
    const first = upsertSkill(waiting === 'custom' ? custom('# Preserved uncommitted user draft') : seed())
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('Publication settled before the intended boundary.') })])
      const commandRaw = await publishCommand(waiting === 'custom')
      expect(await redis.json.getRaw(KEY, '$')).toBe(before)
      release.resolve()
      await expect(first).rejects.toThrow('identity changed')
      expect(await redis.json.getRaw(KEY, '$')).toBe(before)
      expect(await redis.json.getRaw(COMMAND_KEY, '$')).toBe(commandRaw)
      if (waiting === 'custom') expect(await fs.readFile(localFile(), 'utf8')).toBe('# Preserved uncommitted user draft')
      else await expect(fs.access(localFile())).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release.resolve() }
  })

  it('metadata-only refresh keeps its original command basis across filesystem work', async () => {
    await upsertSkill(custom())
    const before = await redis.json.getRaw(KEY, '$')
    const changedFile = '---\nname: app-actions\ndescription: Changed on disk\n---\n# User-owned instructions\n'
    await fs.writeFile(localFile(), changedFile, 'utf8')
    const { entered, release } = pausePublication('custom')
    const first = getSkill(USER, 'app_actions')
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('Refresh settled before the intended boundary.') })])
      const commandRaw = await publishCommand(true)
      expect(await redis.json.getRaw(KEY, '$')).toBe(before)
      release.resolve()
      await expect(first).rejects.toThrow('identity changed')
      expect(await redis.json.getRaw(KEY, '$')).toBe(before)
      expect(await redis.json.getRaw(COMMAND_KEY, '$')).toBe(commandRaw)
      expect(await fs.readFile(localFile(), 'utf8')).toBe(changedFile)
      await expect(getSkill(USER, 'app_actions')).rejects.toThrow('different owners')
    } finally { release.resolve() }
  })

  it('does not bind an existing user-authored system-source collision to the new package', async () => {
    const source = path.join(testHome.directory, 'original-system-skill')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, 'SKILL.md'), '# Original system-source text\n', 'utf8')
    await redis.json.set(KEY, '$', { id: 'app_actions', user_id: USER, name: 'app-actions', source: 'system', is_system: true,
      source_ref: source, skill_markdown: '', bundle_files: [], created_at: 'original', updated_at: 'original' })
    const result = await getSkill(USER, 'app_actions')
    expect(result?.skill_markdown).toBe('# Original system-source text\n')
    expect(result?.source_ref).toBe(source)
  })
})
