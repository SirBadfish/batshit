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

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { listCoreSystemPromptDefinitions } from '../systemPromptRegistry'

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

  it('leaves no retired packaged prompt file behind', async () => {
    const packaged = await fs.readdir(PROMPT_DEFAULTS_DIR)
    expect(packaged).not.toContain('batshit_subagent_addon.md')
  })
})
