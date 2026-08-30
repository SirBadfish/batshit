/**
 * SA-104 P3 — inline `<batshit-memory>` extraction, the shared save-payload contract,
 * and the zip-first-exemption step detector.
 */
import { describe, expect, it } from 'vitest'

import {
  MEMORY_CONTROL_LANES,
  MEMORY_CONTROL_TAG,
  MEMORY_DEFAULT_WINDOW_SETTINGS,
  buildAgentMemoryRecordFields,
  buildMemoryWindowRecord,
  extractMemoryControls,
  isMemoryControlToolStep,
  resolveAgentMemoryEnabled,
  resolveAgentMemorySettingsDraft,
  resolveEffectiveMemoryWindow,
  resolveMemoryIdleGapHours,
  resolveMemoryWindowSettings,
  validateMemorySavePayload
} from './memoryControl'

const VALID_SAVE = '{"lane":"ltm","content":"Josh prefers explicit systems","importance":6}'

function block(inner: string): string {
  return `<${MEMORY_CONTROL_TAG}>\n${inner}\n</${MEMORY_CONTROL_TAG}>`
}

describe('resolveAgentMemoryEnabled', () => {
  it('defaults to false — memory is opt-in', () => {
    expect(resolveAgentMemoryEnabled(null)).toBe(false)
    expect(resolveAgentMemoryEnabled({})).toBe(false)
    expect(resolveAgentMemoryEnabled({ name: 'Agent' })).toBe(false)
  })

  it('reads the snake_case field and the camelCase alias', () => {
    expect(resolveAgentMemoryEnabled({ memory_enabled: true })).toBe(true)
    expect(resolveAgentMemoryEnabled({ memory_enabled: false })).toBe(false)
    expect(resolveAgentMemoryEnabled({ memoryEnabled: true })).toBe(true)
  })
})

describe('validateMemorySavePayload', () => {
  it('accepts a minimal valid save and defaults importance to 5', () => {
    const result = validateMemorySavePayload({ lane: 'ltm', content: 'a fact' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lane).toBe('ltm')
      expect(result.value.importance).toBe(5)
    }
  })

  it('requires a deliberate lane — no default lane exists', () => {
    const result = validateMemorySavePayload({ content: 'a fact' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"lane" is required')
  })

  it('requires trigger terms for stm saves', () => {
    const missing = validateMemorySavePayload({ lane: 'stm', content: 'Maggie is a dog' })
    expect(missing.ok).toBe(false)
    const present = validateMemorySavePayload({
      lane: 'stm',
      content: 'Maggie is a dog',
      trigger_terms: ['maggie']
    })
    expect(present.ok).toBe(true)
  })

  it('folds retired trigger_synonyms into trigger_terms (2026-08-29) so old prompts keep working', () => {
    const folded = validateMemorySavePayload({
      lane: 'stm',
      content: 'Maggie is a dog',
      trigger_terms: ['maggie'],
      trigger_synonyms: ['the setter', 'maggie']
    })
    expect(folded.ok).toBe(true)
    if (folded.ok) {
      expect(folded.value.trigger_terms).toEqual(['maggie', 'the setter'])
      expect('trigger_synonyms' in folded.value).toBe(false)
    }
    // Synonyms alone still satisfy the stm trigger requirement after folding.
    const synonymsOnly = validateMemorySavePayload({
      lane: 'stm',
      content: 'Maggie is a dog',
      trigger_synonyms: ['maggie']
    })
    expect(synonymsOnly.ok).toBe(true)
    if (synonymsOnly.ok) expect(synonymsOnly.value.trigger_terms).toEqual(['maggie'])
  })

  it('accepts a linger override on stm saves only — turns 0-30 or "episode"', () => {
    const base = { lane: 'stm', content: 'Sticky fact', trigger_terms: ['sticky'] }
    const turns = validateMemorySavePayload({ ...base, linger: 10 })
    expect(turns.ok).toBe(true)
    if (turns.ok) expect(turns.value.linger).toBe(10)

    const episode = validateMemorySavePayload({ ...base, linger: 'episode' })
    expect(episode.ok).toBe(true)
    if (episode.ok) expect(episode.value.linger).toBe('episode')

    expect(validateMemorySavePayload({ ...base, linger: 31 }).ok).toBe(false)
    expect(validateMemorySavePayload({ ...base, linger: -1 }).ok).toBe(false)
    expect(validateMemorySavePayload({ ...base, linger: 'forever' }).ok).toBe(false)
    expect(
      validateMemorySavePayload({ lane: 'ltm', content: 'No linger here', linger: 3 }).ok
    ).toBe(false)
  })

  it('rejects out-of-range importance and oversized content', () => {
    expect(validateMemorySavePayload({ lane: 'ltm', content: 'x', importance: 0 }).ok).toBe(false)
    expect(validateMemorySavePayload({ lane: 'ltm', content: 'x', importance: 11 }).ok).toBe(false)
    expect(
      validateMemorySavePayload({ lane: 'ltm', content: 'x'.repeat(4_001) }).ok
    ).toBe(false)
  })

  it('rejects invalid timestamps and non-string list entries', () => {
    expect(
      validateMemorySavePayload({ lane: 'ltm', content: 'x', event_at: 'not-a-date' }).ok
    ).toBe(false)
    expect(
      validateMemorySavePayload({ lane: 'ltm', content: 'x', links: [42] }).ok
    ).toBe(false)
  })

  it('normalizes lane case and dedupes list entries', () => {
    const result = validateMemorySavePayload({
      lane: 'STM',
      content: 'x',
      trigger_terms: ['maggie', 'maggie', ' Maggie2 ']
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lane).toBe('stm')
      expect(result.value.trigger_terms).toEqual(['maggie', 'Maggie2'])
    }
  })
})

describe('extractMemoryControls', () => {
  it('returns the content untouched when no block exists', () => {
    const result = extractMemoryControls('Just a normal message.')
    expect(result.hadBlock).toBe(false)
    expect(result.cleaned).toBe('Just a normal message.')
    expect(result.blocks).toEqual([])
  })

  it('extracts one valid block and cleans the content', () => {
    const content = `Here is my answer.\n\n${block(VALID_SAVE)}`
    const result = extractMemoryControls(content)
    expect(result.hadBlock).toBe(true)
    expect(result.cleaned).toBe('Here is my answer.')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].payload?.lane).toBe('ltm')
  })

  it('extracts EVERY block — each one is an independent save', () => {
    const content = [
      'Answer text.',
      block(VALID_SAVE),
      block('{"lane":"stm","content":"Maggie is the dog","trigger_terms":["maggie"]}')
    ].join('\n\n')
    const result = extractMemoryControls(content)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].payload?.lane).toBe('ltm')
    expect(result.blocks[1].payload?.lane).toBe('stm')
    expect(result.cleaned).toBe('Answer text.')
  })

  it('accepts blocks at start, middle, and end (position-flexible strip layer)', () => {
    const content = `${block(VALID_SAVE)}\nIntro text.\n${block(VALID_SAVE)}\nOutro text.\n${block(VALID_SAVE)}`
    const result = extractMemoryControls(content)
    expect(result.blocks).toHaveLength(3)
    expect(result.cleaned).toContain('Intro text.')
    expect(result.cleaned).toContain('Outro text.')
    expect(result.cleaned).not.toContain(MEMORY_CONTROL_TAG)
  })

  it('surfaces malformed JSON as a loud parseError, never a silent drop', () => {
    const result = extractMemoryControls(`Text.\n${block('{"lane":"ltm", content-oops}')}`)
    expect(result.hadBlock).toBe(true)
    expect(result.blocks[0].parseError).toBeTruthy()
    expect(result.blocks[0].payload).toBeUndefined()
  })

  it('surfaces semantic failures (bad lane) as parseError entries', () => {
    const result = extractMemoryControls(`Text.\n${block('{"lane":"forever","content":"x"}')}`)
    expect(result.blocks[0].parseError).toContain('"lane" is required')
  })

  it('flags an unclosed trailing block and trims it from the cleaned content', () => {
    const result = extractMemoryControls(`Text before.\n<${MEMORY_CONTROL_TAG}>\n{"lane":"ltm"`)
    expect(result.hadBlock).toBe(true)
    expect(result.blocks[0].parseError).toContain('Unclosed')
    expect(result.cleaned).toBe('Text before.')
  })

  it('keeps valid blocks while reporting the malformed one next to them', () => {
    const content = [
      'Answer.',
      block(VALID_SAVE),
      block('not json at all')
    ].join('\n')
    const result = extractMemoryControls(content)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].payload).toBeTruthy()
    expect(result.blocks[1].parseError).toBeTruthy()
  })

  it('has NO bare-JSON fallback — an untagged payload is not a save', () => {
    const result = extractMemoryControls('Text.\n{"lane":"ltm","content":"untagged"}')
    expect(result.hadBlock).toBe(false)
  })
})

describe('isMemoryControlToolStep (zip-first exemption detector, DL-104-17)', () => {
  it('matches broker steps whose ref targets sys.memory.*', () => {
    expect(
      isMemoryControlToolStep({
        toolName: 'native_batshit_tool_use',
        toolInput: { ref: 'fabric:sys.memory.search', input: { query: 'dog' } }
      })
    ).toBe(true)
    expect(
      isMemoryControlToolStep({
        toolName: 'batshit_tool_use',
        toolArgs: { ref: 'fabric:sys.memory.save' }
      })
    ).toBe(true)
  })

  it('matches the n8n lane step shape (workflow tool-node name, ref in args) — P8 live gap', () => {
    // The n8n broker step carries the workflow's tool-node name (e.g. Batshit_Tools),
    // not a batshit_tool_use name. The fabric ref in the args is the authority.
    expect(
      isMemoryControlToolStep({
        tool: 'Batshit_Tools',
        toolName: 'Batshit_Tools',
        toolArgs: { ref: 'fabric:sys.memory.search', input: { query: 'hiking' } },
        action: { tool: 'Batshit_Tools', toolInput: { ref: 'fabric:sys.memory.search' } }
      })
    ).toBe(true)
    expect(
      isMemoryControlToolStep({
        toolName: 'Batshit_Tools',
        toolArgs: { target: 'sys.memory.recall' }
      })
    ).toBe(true)
  })

  it('stays strict: non-memory refs and ref-less steps zip normally', () => {
    expect(
      isMemoryControlToolStep({
        toolName: 'native_batshit_tool_use',
        toolInput: { ref: 'fabric:sys.artifact.update' }
      })
    ).toBe(false)
    expect(
      isMemoryControlToolStep({
        toolName: 'Batshit_Tools',
        toolArgs: { ref: 'fabric:sys.zip.fetch' }
      })
    ).toBe(false)
    expect(
      isMemoryControlToolStep({
        toolName: 'native_web_search',
        toolInput: { query: 'sys.memory.search docs' }
      })
    ).toBe(false)
    expect(isMemoryControlToolStep({ toolName: 'native_batshit_tool_use' })).toBe(false)
    expect(isMemoryControlToolStep(null)).toBe(false)
  })
})

describe('lane vocabulary mirror', () => {
  it('exposes the DL-104-03 lanes exactly', () => {
    expect([...MEMORY_CONTROL_LANES]).toEqual(['awareness', 'stm', 'ltm'])
  })
})

describe('memory window settings (SA-104 P5 — stored now, consumed by P6)', () => {
  it('defaults when the agent record has nothing', () => {
    expect(resolveMemoryWindowSettings(null)).toEqual(MEMORY_DEFAULT_WINDOW_SETTINGS)
    expect(resolveMemoryWindowSettings({})).toEqual(MEMORY_DEFAULT_WINDOW_SETTINGS)
  })

  it('reads and clamps stored snake_case values', () => {
    const settings = resolveMemoryWindowSettings({
      memory_window: {
        floor_mode: 'custom',
        floor_tokens: 50, // below floor min → clamps up
        ceiling_headroom_mode: 'custom',
        ceiling_headroom_tokens: 9_999_999, // above max → clamps down
        nap_threshold_percent: 12 // below min → clamps up
      }
    })
    expect(settings.floorMode).toBe('custom')
    expect(settings.floorTokens).toBe(1_000)
    expect(settings.ceilingHeadroomMode).toBe('custom')
    expect(settings.ceilingHeadroomTokens).toBe(500_000)
    expect(settings.napThresholdPercent).toBe(50)
  })

  it('treats unknown modes as auto', () => {
    const settings = resolveMemoryWindowSettings({
      memory_window: { floor_mode: 'weird', ceiling_headroom_mode: 42 }
    })
    expect(settings.floorMode).toBe('auto')
    expect(settings.ceilingHeadroomMode).toBe('auto')
  })

  it('round-trips through buildMemoryWindowRecord', () => {
    const record = buildMemoryWindowRecord({
      floorMode: 'custom',
      floorTokens: 120_000,
      ceilingHeadroomMode: 'auto',
      ceilingHeadroomTokens: 40_000,
      napThresholdPercent: 85,
      idleGapHours: 12,
      summaryModelMode: 'preset',
      summaryModelPresetId: 'preset_abc'
    })
    expect(record).toEqual({
      floor_mode: 'custom',
      floor_tokens: 120_000,
      ceiling_headroom_mode: 'auto',
      ceiling_headroom_tokens: 40_000,
      nap_threshold_percent: 85,
      idle_gap_hours: 12,
      summary_model_mode: 'preset',
      summary_model_preset_id: 'preset_abc'
    })
    expect(resolveMemoryWindowSettings({ memory_window: record }).floorTokens).toBe(120_000)
  })

  it('P6 fields: idle gap clamps, summary mode normalizes, preset id only kept in preset mode', () => {
    const settings = resolveMemoryWindowSettings({
      memory_window: {
        idle_gap_hours: 500, // above max → clamps to 168
        summary_model_mode: 'preset',
        summary_model_preset_id: '  preset_x  '
      }
    })
    expect(settings.idleGapHours).toBe(168)
    expect(settings.summaryModelMode).toBe('preset')
    expect(settings.summaryModelPresetId).toBe('preset_x')
    expect(resolveMemoryIdleGapHours({ memory_window: { idle_gap_hours: 0 } })).toBe(1) // clamps to min
    expect(resolveMemoryIdleGapHours(null)).toBe(8) // default

    const nonPreset = resolveMemoryWindowSettings({
      memory_window: { summary_model_mode: 'current', summary_model_preset_id: 'stale_id' }
    })
    expect(nonPreset.summaryModelMode).toBe('current')
    expect(nonPreset.summaryModelPresetId).toBeNull()
    expect(
      resolveMemoryWindowSettings({ memory_window: { summary_model_mode: 'weird' } })
        .summaryModelMode
    ).toBe('inherit')
  })
})

describe('resolveEffectiveMemoryWindow (SA-104 P6 — DL-104-07)', () => {
  it('returns null without a model context limit (the nap trigger cannot arm)', () => {
    expect(resolveEffectiveMemoryWindow(MEMORY_DEFAULT_WINDOW_SETTINGS, null)).toBeNull()
    expect(resolveEffectiveMemoryWindow(MEMORY_DEFAULT_WINDOW_SETTINGS, 0)).toBeNull()
  })

  it('derives auto headroom/floor and the nap threshold from the model limit', () => {
    const window = resolveEffectiveMemoryWindow(MEMORY_DEFAULT_WINDOW_SETTINGS, 200_000)!
    // auto headroom = clamp(200k × 0.12, 16_384, 128_000) = 24_000
    expect(window.headroomTokens).toBe(24_000)
    expect(window.usableTokens).toBe(176_000)
    // auto floor = clamp(176k × 0.25, 20_000, 100_000) = 44_000
    expect(window.floorTokens).toBe(44_000)
    // nap at 80% of usable
    expect(window.napAtTokens).toBe(140_800)

    const big = resolveEffectiveMemoryWindow(MEMORY_DEFAULT_WINDOW_SETTINGS, 1_000_000)!
    expect(big.headroomTokens).toBe(120_000)
    expect(big.floorTokens).toBe(100_000) // auto floor cap
  })

  it('honors custom values and caps the floor below usable context', () => {
    const window = resolveEffectiveMemoryWindow(
      {
        ...MEMORY_DEFAULT_WINDOW_SETTINGS,
        floorMode: 'custom',
        floorTokens: 2_000_000, // absurd — capped to 80% of usable
        ceilingHeadroomMode: 'custom',
        ceilingHeadroomTokens: 50_000,
        napThresholdPercent: 90
      },
      200_000
    )!
    expect(window.headroomTokens).toBe(50_000)
    expect(window.usableTokens).toBe(150_000)
    expect(window.floorTokens).toBe(120_000)
    expect(window.napAtTokens).toBe(135_000)
  })
})

describe('agent memory settings draft (Settings ↔ record round-trip)', () => {
  it('resolves the full bundle from an agent record', () => {
    const draft = resolveAgentMemorySettingsDraft({
      memory_enabled: true,
      memory_linger_turns: 4,
      memory_lane_budgets: { on_my_mind: 1_500, triggers: 900, recalled: 3_000 },
      memory_window: { floor_mode: 'custom', floor_tokens: 64_000 }
    })
    expect(draft.enabled).toBe(true)
    expect(draft.lingerTurns).toBe(4)
    expect(draft.budgets).toEqual({ onMyMind: 1_500, triggers: 900, recalled: 3_000 })
    expect(draft.window.floorMode).toBe('custom')
    expect(draft.window.floorTokens).toBe(64_000)
  })

  it('builds normalized record fields the Settings save payload writes', () => {
    const fields = buildAgentMemoryRecordFields({
      enabled: true,
      lingerTurns: 99, // above max → clamps to 8
      budgets: { onMyMind: 2_000, triggers: 1_200, recalled: 2_400 },
      window: MEMORY_DEFAULT_WINDOW_SETTINGS
    })
    expect(fields.memory_enabled).toBe(true)
    expect(fields.memory_linger_turns).toBe(8)
    expect(fields.memory_lane_budgets).toEqual({
      on_my_mind: 2_000,
      triggers: 1_200,
      recalled: 2_400
    })
    expect(fields.memory_window.floor_mode).toBe('auto')
  })

  it('the resolvers read back exactly what the builder writes (no drift)', () => {
    const fields = buildAgentMemoryRecordFields({
      enabled: false,
      lingerTurns: 3,
      budgets: { onMyMind: 500, triggers: 700, recalled: 900 },
      window: { ...MEMORY_DEFAULT_WINDOW_SETTINGS, napThresholdPercent: 90 }
    })
    const roundTripped = resolveAgentMemorySettingsDraft(fields)
    expect(roundTripped.enabled).toBe(false)
    expect(roundTripped.lingerTurns).toBe(3)
    expect(roundTripped.budgets).toEqual({ onMyMind: 500, triggers: 700, recalled: 900 })
    expect(roundTripped.window.napThresholdPercent).toBe(90)
  })
})
