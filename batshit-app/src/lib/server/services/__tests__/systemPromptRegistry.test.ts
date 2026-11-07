/**
 * SA-111 P1 (DL-111-01 / DL-111-02) — the Admin "Core System Prompts" card is generated
 * straight from this registry, so the registry IS the Admin contract: every entry's label
 * and description is what Josh reads in Settings -> Admin, and every entry must have a
 * packaged default file on disk or the card fails to load that prompt.
 *
 * The retired entry is the reason these tests exist. `subagent_addon` ("Subagent Addon")
 * told Admin it was "Text shown to primary agents explaining when and how to use
 * subagents" for nine months while no compiler read it (F1/F2). A registry entry with a
 * false description is worse than no entry, so the replacement is pinned by name here.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  corePromptMetadataKey,
  foldRetiredZipToolPrompts,
  listCoreSystemPromptDefinitions,
  listCoreSystemPrompts,
  getCoreSystemPrompt,
  reconcileCoreSystemPromptsAfterRestore,
  removeRetiredSystemPrompts,
  retiredZipToolPromptKeys,
  saveCoreSystemPrompt
} from '../systemPromptRegistry'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createHash } from 'node:crypto'

useRedisTestServer()

const PROMPT_DEFAULTS_DIR = path.resolve(process.cwd(), '../docs/batshit_System_Prompts')

describe('core system prompt registry', () => {
  const definitions = listCoreSystemPromptDefinitions()

  it('ships a packaged default file for every registered prompt', async () => {
    for (const definition of definitions) {
      const filePath = path.join(PROMPT_DEFAULTS_DIR, definition.defaultFile)
      await expect(
        fs.access(filePath).then(() => true),
        `missing packaged default for ${definition.id}: ${definition.defaultFile}`
      ).resolves.toBe(true)
    }
  })

  it('registers the delegation guidance prompt with its Admin label and key', () => {
    const guidance = definitions.find((definition) => definition.id === 'subagent_guidance')

    expect(guidance).toBeDefined()
    expect(guidance).toMatchObject({
      redisKey: 'batshit:subagent_guidance',
      label: 'Subagent & Worker Guidance',
      defaultFile: 'batshit_subagent_guidance.md'
    })
    expect(guidance!.description).toContain('delegate')
  })

  it('no longer registers the retired Subagent Addon (DL-111-02)', () => {
    expect(definitions.some((definition) => definition.id === ('subagent_addon' as any))).toBe(false)
    expect(definitions.some((definition) => definition.redisKey.includes('subagent_instructions'))).toBe(
      false
    )
    expect(definitions.some((definition) => definition.defaultFile === 'batshit_subagent_addon.md')).toBe(
      false
    )
  })

  it('keeps registry ids, Redis keys, and packaged files unique', () => {
    const ids = definitions.map((definition) => definition.id)
    const keys = definitions.map((definition) => definition.redisKey)
    const files = definitions.map((definition) => definition.defaultFile)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(files).size).toBe(files.length)
  })

  it('flags stale custom setup pointers while preserving the exact saved text', async () => {
    const text = '# My custom prompt\nThe `tool_discovery` section of your DCM lists tools.'
    const result = await saveCoreSystemPrompt('api_primary', text)
    expect(result.customized).toBe(true)
    expect(result.setupCompatibilityNotice).toContain('Agent Setup and setup_changes')
    expect(result.value).toBe(text)
    expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe(text)
    const current = await saveCoreSystemPrompt('api_primary', '# My custom prompt\nUse tool_discovery in Agent Setup and setup_changes in your DCM.')
    expect(current.setupCompatibilityNotice).toBeUndefined()
    expect(current.customized).toBe(true)
  })

  // SA-139 R4: `cli_primary` is no longer a registered prompt; a saved `runtime:cli` section
  // (a retired, never-active scope) is still accepted and not flagged.
  it('flags retired API utility pointers without rewriting saved scripts or retired CLI sections', async () => {
    const text = '# Custom API\nCall native_skill with skillId and action="read".'
    const api = await saveCoreSystemPrompt('api_primary', text)
    expect(api.value).toBe(text)
    expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe(text)
    expect(api.setupCompatibilityNotice).toContain('API tool calls that moved behind Tool Use')
    await expect(saveCoreSystemPrompt('cli_primary' as never, text)).rejects.toThrow('Unknown core system prompt: cli_primary')
    expect(await redis.get('batshit:batshit_mode4_system_prompt')).toBeNull()
    expect((await saveCoreSystemPrompt('api_primary', 'Call native_skill with action="script_run".')).setupCompatibilityNotice).toBeUndefined()
    expect((await saveCoreSystemPrompt('dynamic_mcp', '<!-- runtime:cli -->\nCall native_web_search.\n<!-- /runtime -->')).setupCompatibilityNotice).toBeUndefined()
  })

  it('flags the moved API Subagent roster while preserving retired CLI-only DCM roster guidance', async () => {
    const text = 'The `subagents:` roster in your DCM is the authority.'
    expect((await saveCoreSystemPrompt('api_primary', text)).setupCompatibilityNotice).toContain('Agent Setup and setup_changes')
    const scoped = await saveCoreSystemPrompt('subagent_guidance', `<!-- runtime:cli -->\n${text}\n<!-- /runtime -->`)
    expect(scoped.value).toBe(`<!-- runtime:cli -->\n${text}\n<!-- /runtime -->`)
    expect(scoped.setupCompatibilityNotice).toBeUndefined()
  })

  it.each(['<!-- runtime:api -->\nUnclosed', '<!-- runtime:unknown -->\nUnknown\n<!-- /runtime -->', '<!-- /runtime -->\nUnmatched'])('keeps malformed custom runtime text readable and editable with a visible diagnostic (%s)', async text => {
    const saved = await saveCoreSystemPrompt('api_primary', text)
    expect(saved.value).toBe(text)
    expect(saved.setupCompatibilityNotice).toContain('invalid runtime markers')
    expect(saved.setupCompatibilityNotice).toContain('saved text is unchanged')
    expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe(text)
    expect((await listCoreSystemPrompts()).find(row => row.id === 'api_primary')?.setupCompatibilityNotice).toContain('invalid runtime markers')
    expect((await getCoreSystemPrompt('api_primary')).value).toBe(text)
    const repaired = await saveCoreSystemPrompt('api_primary', '# Repaired custom prompt')
    expect(repaired.value).toBe('# Repaired custom prompt')
    expect(repaired.setupCompatibilityNotice).toBeUndefined()
  })

  it('leaves no retired packaged prompt file behind', async () => {
    const packaged = await fs.readdir(PROMPT_DEFAULTS_DIR)
    expect(packaged).not.toContain('batshit_subagent_addon.md')
    expect(packaged).not.toContain('batshit_primary_agent_cli_system_prompt.md')
  })

  // SA-139 R4 (D14): the CLI Primary Agent System Prompt went with the Claude Code CLI Primary
  // lane. The startup sweep removes its text, time and metadata, and leaves every live prompt.
  it('no longer registers cli_primary, and the startup sweep removes its three keys', async () => {
    const CLI_KEYS = ['batshit:batshit_mode4_system_prompt', 'batshit:batshit_mode4_system_prompt:last_updated', 'batshit:system_prompt_meta:cli_primary']
    expect(definitions.some((definition) => definition.id === ('cli_primary' as never))).toBe(false)
    expect(definitions.some((definition) => definition.redisKey === CLI_KEYS[0])).toBe(false)
    await redis.set(CLI_KEYS[0], '# Old CLI Primary prompt')
    await redis.set(CLI_KEYS[1], '2026-10-01T00:00:00.000Z')
    await redis.set(CLI_KEYS[2], { promptId: 'cli_primary', customized: true })
    await redis.set('batshit:batshit_mode3_system_prompt', '# Live API prompt')

    expect(await removeRetiredSystemPrompts()).toEqual({ removed: ['cli_primary (batshit:batshit_mode4_system_prompt) (3 keys)'] })
    for (const key of CLI_KEYS) expect(await redis.get(key)).toBeNull()
    expect(await redis.get('batshit:batshit_mode3_system_prompt')).toBe('# Live API prompt')
    // A second run finds nothing left.
    expect(await removeRetiredSystemPrompts()).toEqual({ removed: [] })
  })
})


describe('BL-1544 default-only CLI prompt refresh', () => {
  it.each(['tool_guidance_zip'] as const)('refreshes %s by default hash and preserves a customized record', async (id) => {
    const definition = listCoreSystemPromptDefinitions().find((entry) => entry.id === id)!
    const oldDefault = 'previous packaged tool instructions'
    const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
    await redis.set(definition.redisKey, oldDefault)
    await redis.set(corePromptMetadataKey(id), { promptId: id, defaultHash: hash(oldDefault), customized: false })
    await listCoreSystemPrompts()
    const currentDefault = await fs.readFile(path.join(PROMPT_DEFAULTS_DIR, definition.defaultFile), 'utf8')
    // SA-139 R4: the packaged default keeps only its API section.
    expect(currentDefault).toContain('{{ $api_tool_zip_guidance }}')
    expect(currentDefault).not.toContain('{{ $cli_tool_zip_guidance }}')
    expect(await redis.get(definition.redisKey)).toBe(currentDefault)
    expect(await redis.get(corePromptMetadataKey(id))).toMatchObject({ customized: false, defaultHash: hash(currentDefault) })
    await saveCoreSystemPrompt(id, 'User customized instructions remain exact.')
    await listCoreSystemPrompts()
    expect(await redis.get(definition.redisKey)).toBe('User customized instructions remain exact.')
    expect(await redis.get(corePromptMetadataKey(id))).toMatchObject({ customized: true })
  })
})

describe('core prompt startup provenance reads', () => {
  it.each(['metadata', 'last-updated'] as const)('propagates a failed %s read instead of reporting completed startup', async (kind) => {
    const id = 'tool_guidance_zip'
    const definition = listCoreSystemPromptDefinitions().find((entry) => entry.id === id)!
    await saveCoreSystemPrompt(id, 'A preserved customized prompt.')
    const key = kind === 'metadata' ? corePromptMetadataKey(id) : `${definition.redisKey}:last_updated`
    const before = await redis.get(key)
    const isMock = vi.isMockFunction(redis.execute)
    const original = isMock ? (redis.execute as any).getMockImplementation() : redis.execute.bind(redis)
    const bind = (target: any, property: PropertyKey) => typeof target[property] === 'function'
      ? target[property].bind(target) : target[property]
    const read = (target: any) => async (targetKey: string, ...rest: any[]) => {
      if (targetKey === key) throw new Error('Injected prompt provenance read failure')
      return target.get(targetKey, ...rest)
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation(async (operation: any) => original((client: any) => operation(
      new Proxy({}, { get(_target, property) {
        if (kind === 'metadata' && property === 'json') return new Proxy({}, {
          get(_json, field) { return field === 'get' ? read(client.json) : bind(client.json, field) }
        })
        if (kind === 'last-updated' && property === 'get') return read(client)
        return bind(client, property)
      } })
    )))
    try {
      await expect(listCoreSystemPrompts()).rejects.toThrow('Injected prompt provenance read failure')
    } finally {
      if (isMock) spy.mockImplementation(original)
      else spy.mockRestore()
    }
    expect(await redis.get(definition.redisKey)).toBe('A preserved customized prompt.')
    expect(await redis.get(key)).toEqual(before)
  })

  it('refuses unsupported present metadata without resetting its record or prompt', async () => {
    const id = 'tool_guidance_zip'
    const definition = listCoreSystemPromptDefinitions().find((entry) => entry.id === id)!
    await redis.set(definition.redisKey, 'A preserved customized prompt.')
    const unsupported = { customized: 'unknown' }
    await redis.set(corePromptMetadataKey(id), unsupported)
    await expect(listCoreSystemPrompts()).rejects.toThrow('metadata is unreadable or unsupported')
    expect(await redis.get(definition.redisKey)).toBe('A preserved customized prompt.')
    expect(await redis.get(corePromptMetadataKey(id))).toEqual(unsupported)
  })
})

/**
 * BL-1777: the two zip tool prompts ("Tool Prompt: Zip Control Enabled" / "... Disabled") had been
 * the same placeholder shell since a26ea0697, filled from one block built in code that branches on
 * zip control itself. They are one record now, "Tool Prompt: Zips". The fold moves what an admin
 * saved in the old records: the Disabled record's edit first (every agent compiled it unless the
 * hidden zip-control experiment was on), else the Enabled record's; an edit it cannot carry stays
 * where it is, read by nothing, and is named in a warning; nothing that is the default stays.
 */
describe('one zip tool prompt (BL-1777)', () => {
  const OLD = {
    disabled: { id: 'tool_guidance_zip_disabled', key: 'batshit:tool_guidance_zip_disabled_prompt' },
    enabled: { id: 'tool_guidance_zip_enabled', key: 'batshit:tool_guidance_zip_enabled_prompt' }
  } as const
  const MERGED_KEY = 'batshit:tool_guidance_zip_prompt'
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  const mergedDefault = () => fs.readFile(path.join(PROMPT_DEFAULTS_DIR, 'batshit_tool_prompt_zips.md'), 'utf8')
  const metaKey = (id: string) => `batshit:system_prompt_meta:${id}`

  async function seedOld(which: keyof typeof OLD, text: string, metadata: Record<string, unknown> | null) {
    await redis.set(OLD[which].key, text)
    await redis.set(`${OLD[which].key}:last_updated`, '2026-10-01T00:00:00.000Z')
    if (metadata) await redis.set(metaKey(OLD[which].id), { promptId: OLD[which].id, updatedAt: '2026-10-01T00:00:00.000Z', ...metadata })
  }

  async function oldKeysLeft(which: keyof typeof OLD) {
    const keys = [OLD[which].key, `${OLD[which].key}:last_updated`, metaKey(OLD[which].id)]
    const left: string[] = []
    for (const key of keys) if (await redis.exists(key)) left.push(key)
    return left
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers one record, "Tool Prompt: Zips", and packages one default file', async () => {
    const definitions = listCoreSystemPromptDefinitions()
    const zips = definitions.filter((definition) => definition.redisKey.includes('tool_guidance_zip'))
    expect(zips).toHaveLength(1)
    expect(zips[0]).toMatchObject({
      id: 'tool_guidance_zip',
      redisKey: MERGED_KEY,
      label: 'Tool Prompt: Zips',
      defaultFile: 'batshit_tool_prompt_zips.md'
    })
    const packaged = await fs.readdir(PROMPT_DEFAULTS_DIR)
    expect(packaged).toContain('batshit_tool_prompt_zips.md')
    expect(packaged).not.toContain('batshit_tool_prompt_zip_control_enabled.md')
    expect(packaged).not.toContain('batshit_tool_prompt_zip_control_disabled.md')
    // The record is the shell the code fills; the permission branch is in code. SA-139 R4: the
    // API section is the one runtime section left.
    const text = await mergedDefault()
    expect(text).not.toContain('{{ $cli_tool_zip_guidance }}')
    expect(text).not.toContain('<!-- runtime:cli -->')
    expect(text).toContain('{{ $api_tool_zip_guidance }}')
    // The old keys are named for the sweep and the backup, text, time, and metadata.
    expect(retiredZipToolPromptKeys().sort()).toEqual(
      [OLD.disabled, OLD.enabled]
        .flatMap((old) => [old.key, `${old.key}:last_updated`, metaKey(old.id)])
        .sort()
    )
  })

  it('removes old records that hold only a default, and seeds the one record from its own default', async () => {
    const current = await mergedDefault()
    await seedOld('disabled', current, { defaultHash: hash(current), customized: false })
    // An older packaged default this instance never refreshed is a default too.
    await seedOld('enabled', 'an older packaged default\n', { defaultHash: hash('an older packaged default\n'), customized: false })

    const fold = await foldRetiredZipToolPrompts()

    expect(fold).toEqual({ carried: null, kept: [], removed: ['Tool Prompt: Zip Control Disabled', 'Tool Prompt: Zip Control Enabled'] })
    expect(await oldKeysLeft('disabled')).toEqual([])
    expect(await oldKeysLeft('enabled')).toEqual([])
    // Review N-a: the fold seeds the one record itself (the boot seed after it is not awaited), so
    // no compile after the fold reads an absent key.
    expect(await redis.get(MERGED_KEY)).toBe(current)
    expect(await redis.get(metaKey('tool_guidance_zip'))).toMatchObject({ customized: false, defaultHash: hash(current) })
    await listCoreSystemPrompts()
    expect(await redis.get(MERGED_KEY)).toBe(current)
  })

  it.each(['disabled', 'enabled'] as const)('carries the only edit (%s) into the one record, as customized, and removes the old record', async (which) => {
    await seedOld(which, `my ${which} zip guidance\n`, { defaultHash: hash('an older packaged default\n'), customized: true })

    const fold = await foldRetiredZipToolPrompts()

    const label = which === 'disabled' ? 'Tool Prompt: Zip Control Disabled' : 'Tool Prompt: Zip Control Enabled'
    expect(fold).toEqual({ carried: label, kept: [], removed: [label] })
    expect(await redis.get(MERGED_KEY)).toBe(`my ${which} zip guidance\n`)
    expect(await oldKeysLeft(which)).toEqual([])
    const summary = (await listCoreSystemPrompts()).find((entry) => entry.id === 'tool_guidance_zip')!
    // Still the admin's edit, never refreshed; it was written against an older default.
    expect(await redis.get(MERGED_KEY)).toBe(`my ${which} zip guidance\n`)
    expect(summary).toMatchObject({ customized: true, matchesDefault: false, newDefaultAvailable: true })
  })

  it('takes the Disabled edit when both differ, and keeps the Enabled edit where it is, named in a warning', async () => {
    await seedOld('disabled', 'my default-path zip guidance\n', { defaultHash: hash('x'), customized: true })
    await seedOld('enabled', 'my zip-control zip guidance\n', { defaultHash: hash('x'), customized: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const fold = await foldRetiredZipToolPrompts()

    expect(fold).toEqual({
      carried: 'Tool Prompt: Zip Control Disabled',
      kept: ['Tool Prompt: Zip Control Enabled'],
      removed: ['Tool Prompt: Zip Control Disabled']
    })
    expect(await redis.get(MERGED_KEY)).toBe('my default-path zip guidance\n')
    expect(await redis.get(OLD.enabled.key)).toBe('my zip-control zip guidance\n')
    expect(await oldKeysLeft('enabled')).toHaveLength(3)
    expect(warn.mock.calls.flat().join(' ')).toContain(OLD.enabled.key)

    // Running again changes nothing: the kept edit stays, the one record keeps its text.
    expect(await foldRetiredZipToolPrompts()).toEqual({ carried: null, kept: ['Tool Prompt: Zip Control Enabled'], removed: [] })
    expect(await redis.get(MERGED_KEY)).toBe('my default-path zip guidance\n')
    // Once the one record holds the same text (the admin copied it), the old record goes.
    await saveCoreSystemPrompt('tool_guidance_zip', 'my zip-control zip guidance\n')
    expect(await foldRetiredZipToolPrompts()).toEqual({ carried: null, kept: [], removed: ['Tool Prompt: Zip Control Enabled'] })
    expect(await oldKeysLeft('enabled')).toEqual([])
  })

  it('carries one edit once when both old records hold the same text', async () => {
    await seedOld('disabled', 'same edit\n', null)
    await seedOld('enabled', 'same edit\n', null)
    const fold = await foldRetiredZipToolPrompts()
    expect(fold).toEqual({
      carried: 'Tool Prompt: Zip Control Disabled',
      kept: [],
      removed: ['Tool Prompt: Zip Control Disabled', 'Tool Prompt: Zip Control Enabled']
    })
    expect(await redis.get(MERGED_KEY)).toBe('same edit\n')
  })

  it('never writes over an edit the one record already holds', async () => {
    await saveCoreSystemPrompt('tool_guidance_zip', 'my newer edit\n')
    await seedOld('disabled', 'my older edit\n', { defaultHash: hash('x'), customized: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fold = await foldRetiredZipToolPrompts()
    expect(fold).toEqual({ carried: null, kept: ['Tool Prompt: Zip Control Disabled'], removed: [] })
    expect(await redis.get(MERGED_KEY)).toBe('my newer edit\n')
    expect(await redis.get(OLD.disabled.key)).toBe('my older edit\n')
  })

  it('reads an old record with no metadata and other text as an edit (BL-372: never replaced on a guess)', async () => {
    await seedOld('disabled', 'text from a backup made before metadata\n', null)
    const fold = await foldRetiredZipToolPrompts()
    expect(fold.carried).toBe('Tool Prompt: Zip Control Disabled')
    expect(await redis.get(MERGED_KEY)).toBe('text from a backup made before metadata\n')
  })

  it('a restore of an older backup folds its records right away', async () => {
    await seedOld('disabled', 'restored edit\n', { defaultHash: hash('x'), customized: true })
    await reconcileCoreSystemPromptsAfterRestore()
    expect(await redis.get(MERGED_KEY)).toBe('restored edit\n')
    expect(await oldKeysLeft('disabled')).toEqual([])
  })

  // Review S-A: the metadata too, through the raw client. The facade answers null for a failed read,
  // which read an untouched older default as an edit and carried it as customized for good.
  it.each([
    ['its text', OLD.disabled.key, 'get'],
    ['its metadata', `batshit:system_prompt_meta:${OLD.disabled.id}`, 'json.get']
  ] as const)('a failed read of an old record (%s) throws and changes nothing', async (_what, failingKey, method) => {
    const olderDefault = 'an older packaged default\n'
    await seedOld('disabled', olderDefault, { defaultHash: hash(olderDefault), customized: false })
    const metadataBefore = await redis.get(metaKey(OLD.disabled.id))
    // On the default lane `redis.execute` is already a mock: restoreAllMocks does not put its own
    // implementation back, so the test does, in `finally`, or the failure leaks into later tests.
    const executeIsMock = vi.isMockFunction(redis.execute)
    const savedExecute = executeIsMock ? (redis.execute as any).getMockImplementation() : null
    const execute = executeIsMock ? savedExecute : redis.execute.bind(redis)
    const failingGet = (target: any) => async (key: string, ...rest: any[]) => {
      if (key === failingKey) throw new Error('injected read failure')
      return target.get(key, ...rest)
    }
    const bound = (target: any, property: PropertyKey) => {
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    }
    const spy = vi.spyOn(redis, 'execute').mockImplementation(async (operation: any) =>
      execute((client: any) =>
        operation(
          // Proxies over empty targets: the real client's `json` is a read-only property, which a
          // proxy of the client itself may not replace.
          new Proxy({}, {
            get(_target, property) {
              if (method === 'get' && property === 'get') return failingGet(client)
              if (method === 'json.get' && property === 'json') {
                return new Proxy({}, {
                  get(_json, jsonProperty) {
                    return jsonProperty === 'get' ? failingGet(client.json) : bound(client.json, jsonProperty)
                  }
                })
              }
              return bound(client, property)
            }
          })
        )
      )
    )
    try {
      await expect(foldRetiredZipToolPrompts()).rejects.toThrow('injected read failure')
    } finally {
      if (executeIsMock) spy.mockImplementation(savedExecute)
      else spy.mockRestore()
    }
    expect(await redis.get(OLD.disabled.key)).toBe(olderDefault)
    expect(await redis.get(metaKey(OLD.disabled.id))).toEqual(metadataBefore)
    expect(await redis.exists(MERGED_KEY)).toBe(false)
  })

  // Review N-d: a fold that stopped after writing the one record and before deleting the old one.
  it.each([
    ['with its metadata', true],
    ['before its metadata', false]
  ] as const)('a fold stopped part way (one record written %s) finishes on the next run', async (_when, withMetadata) => {
    await seedOld('disabled', 'my edit\n', { defaultHash: hash('x'), customized: true })
    await redis.set(MERGED_KEY, 'my edit\n')
    if (withMetadata) {
      await redis.set(metaKey('tool_guidance_zip'), { promptId: 'tool_guidance_zip', defaultHash: hash('x'), customized: true, updatedAt: 'x' })
    }

    expect(await foldRetiredZipToolPrompts()).toEqual({ carried: null, kept: [], removed: ['Tool Prompt: Zip Control Disabled'] })

    expect(await redis.get(MERGED_KEY)).toBe('my edit\n')
    expect(await oldKeysLeft('disabled')).toEqual([])
    const summary = (await listCoreSystemPrompts()).find((entry) => entry.id === 'tool_guidance_zip')!
    expect(await redis.get(MERGED_KEY)).toBe('my edit\n')
    expect(summary).toMatchObject({ customized: true, matchesDefault: false })
  })
})
