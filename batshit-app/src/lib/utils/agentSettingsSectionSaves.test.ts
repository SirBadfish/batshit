import { describe, expect, it } from 'vitest'
import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { CodexAgentSettings } from '$lib/types/codex'
import { diffAgentBlock } from '$lib/utils/agentBlockFieldSettings'
import {
  diffMcpSection,
  diffZipPayload,
  zipPayloadForSave,
  type McpSectionValues,
  type ZipPayloadBody
} from './agentSettingsSectionSaves'

/**
 * BL-848, BL-855, the Agent Settings half: what the Primary Agent's Tool Grid save, its zip save,
 * and its Codex and Claude sections send. Each is a pure function of two copies, the section as it
 * loaded or was last saved and the section now, so the rule is tested here without the panel; the
 * panel's own tests (`AgentSettingsPanel.toolGridSaves.test.ts`, `...cliBlockSaves.test.ts`) render
 * the real panel against the real route.
 *
 * The walks at the end are the guard the Settings Auto-Save Contract asks for: a new field a save
 * can name but no comparison sees would silently lose its changes. Each table has one entry per key
 * of the type the save builds, so a key added without a change to test is a type error.
 */

const DCM_EMPTY = {
  version: 1 as const,
  groups: {},
  tools: {},
  groupDisplayPreferences: {},
  toolDisplayPreferences: {}
}

function mcpValues(overrides: Partial<McpSectionValues> = {}): McpSectionValues {
  return { gateways: ['gw_a'], selections: ['tool_one'], dcm: DCM_EMPTY, ...overrides }
}

describe('what the Tool Grid save sends (BL-855)', () => {
  it('sends nothing when nothing changed', () => {
    expect(diffMcpSection(mcpValues(), mcpValues())).toEqual({})
  })

  it('sends the gateway list whole, alone, when it differs', () => {
    expect(diffMcpSection(mcpValues(), mcpValues({ gateways: ['gw_a', 'gw_b'] }))).toEqual({
      defaultMCPGateways: ['gw_a', 'gw_b']
    })
    expect(diffMcpSection(mcpValues({ gateways: ['gw_a', 'gw_b'] }), mcpValues({ gateways: [] }))).toEqual({
      defaultMCPGateways: []
    })
  })

  it('sends the tool selections whole, alone, when they differ', () => {
    expect(diffMcpSection(mcpValues(), mcpValues({ selections: ['tool_one', 'tool_two'] }))).toEqual({
      defaultMCPToolSelections: ['tool_one', 'tool_two']
    })
  })

  it('sends the display settings entry by entry, a removed entry as null', () => {
    const held = mcpValues({
      dcm: { ...DCM_EMPTY, groups: { g1: 'hidden', g2: 'group-only' }, groupDisplayPreferences: { g1: 'use-global', g2: 'group-only' } }
    })
    const next = mcpValues({
      dcm: { ...DCM_EMPTY, groups: { g2: 'group-only' }, groupDisplayPreferences: { g2: 'group-only' } }
    })
    expect(diffMcpSection(held, next)).toEqual({
      dcmDisplaySettings: { groups: { g1: null }, groupDisplayPreferences: { g1: null } }
    })
  })

  it('sends the whole display block when the agent held none under the current name yet', () => {
    const older = { ...DCM_EMPTY, groups: { g1: 'hidden' }, groupDisplayPreferences: { g1: 'use-global' } }
    const save = diffMcpSection(mcpValues({ dcm: null }), mcpValues({ dcm: { ...older, groups: { g1: 'hidden', g2: 'group-only' } } }))
    expect(save.dcmDisplaySettings).toMatchObject({ groups: { g1: 'hidden', g2: 'group-only' } })
  })

  it('names each part on its own', () => {
    const save = diffMcpSection(
      mcpValues(),
      mcpValues({ gateways: ['gw_b'], selections: [], dcm: { ...DCM_EMPTY, tools: { t1: 'hidden' } } })
    )
    expect(Object.keys(save).sort()).toEqual(['dcmDisplaySettings', 'defaultMCPGateways', 'defaultMCPToolSelections'])
  })
})

/** A payload with a value in every field the zip save can name. */
function zipBase(): ZipPayloadBody {
  return {
    zip_ai_view_mode: null,
    zip_tool_notes_enabled: null,
    buffer_size: null,
    buffer_size_image: null,
    buffer_size_error: null,
    buffer_size_subagent: null,
    buffer_size_read_file: null,
    buffer_size_write_file: null,
    buffer_size_edit_file: null,
    buffer_size_execute_command: null,
    buffer_size_list_files: null,
    buffer_size_all_other_tools: null,
    zip_threshold_error: null,
    zip_threshold_image: null,
    zip_threshold_subagent: null,
    zip_threshold_read_file: null,
    zip_threshold_write_file: null,
    zip_threshold_edit_file: null,
    zip_threshold_execute_command: null,
    zip_threshold_list_files: null,
    zip_threshold_all_other_tools: null,
    auto_zip_error: null,
    auto_zip_image: null,
    auto_zip_subagent: null,
    auto_zip_read_file: null,
    auto_zip_write_file: null,
    auto_zip_edit_file: null,
    auto_zip_execute_command: null,
    auto_zip_list_files: null,
    auto_zip_all_other_tools: null,
    zip_disabled_error: null,
    zip_disabled_image: null,
    zip_disabled_subagent: null,
    zip_disabled_read_file: null,
    zip_disabled_write_file: null,
    zip_disabled_edit_file: null,
    zip_disabled_execute_command: null,
    zip_disabled_list_files: null,
    zip_disabled_all_other_tools: null,
    custom_tool_settings: []
  }
}

describe('what the zip save sends (BL-855)', () => {
  it('sends nothing when nothing changed', () => {
    expect(diffZipPayload(zipBase(), zipBase())).toEqual({})
  })

  it('sends each field that changed on its own; null (inherit) is a real value', () => {
    expect(diffZipPayload(zipBase(), { ...zipBase(), zip_ai_view_mode: 'inline' })).toEqual({ zip_ai_view_mode: 'inline' })
    expect(
      diffZipPayload({ ...zipBase(), buffer_size_read_file: 9, auto_zip_error: true }, { ...zipBase(), buffer_size_read_file: 9 })
    ).toEqual({ auto_zip_error: null })
  })

  it('counts a missing field and null as the same', () => {
    const { zip_tool_notes_enabled: _dropped, ...withoutNotes } = zipBase()
    expect(diffZipPayload(withoutNotes as ZipPayloadBody, zipBase())).toEqual({})
    expect(diffZipPayload(zipBase(), withoutNotes as ZipPayloadBody)).toEqual({})
    // A field the copy held and the form no longer names goes as null (it is removed, not kept).
    expect(diffZipPayload({ ...zipBase(), zip_tool_notes_enabled: true }, withoutNotes as ZipPayloadBody)).toEqual({
      zip_tool_notes_enabled: null
    })
  })

  it('sends custom_tool_settings whole, alone, when a row differs', () => {
    const next = { ...zipBase(), custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8 }] }
    expect(diffZipPayload(zipBase(), next)).toEqual({ custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8 }] })
    expect(
      diffZipPayload(next, { ...next, custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8, auto_zip: true }] })
    ).toEqual({ custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 8, auto_zip: true }] })
    expect(diffZipPayload(next, zipBase())).toEqual({ custom_tool_settings: [] })
  })

  it('does not count a reordered custom tool list as a change, and sends its rows in one order', () => {
    const rows = [
      { tool_name: 'tool_b', buffer_size: 2 },
      { tool_name: 'tool_a', buffer_size: 1 }
    ]
    const base = { ...zipBase(), custom_tool_settings: rows }
    expect(diffZipPayload(base, { ...base, custom_tool_settings: [...rows].reverse() })).toEqual({})
    expect(zipPayloadForSave(base).custom_tool_settings?.map((row) => row.tool_name)).toEqual(['tool_a', 'tool_b'])
    // The input is left as it was.
    expect(base.custom_tool_settings.map((row) => row.tool_name)).toEqual(['tool_b', 'tool_a'])
  })
})

/** One entry per field of the zip payload: a change to it, from `zipBase()`. */
const CHANGE_ONE_ZIP_FIELD: { [K in keyof ZipPayloadBody]-?: ZipPayloadBody[K] } = {
  zip_ai_view_mode: 'appended',
  zip_tool_notes_enabled: false,
  buffer_size: 3,
  buffer_size_image: 0,
  buffer_size_error: 3,
  buffer_size_subagent: 3,
  buffer_size_read_file: 3,
  buffer_size_write_file: 3,
  buffer_size_edit_file: 3,
  buffer_size_execute_command: 3,
  buffer_size_list_files: 3,
  buffer_size_all_other_tools: 3,
  zip_threshold_error: 5,
  zip_threshold_image: 5,
  zip_threshold_subagent: 5,
  zip_threshold_read_file: 5,
  zip_threshold_write_file: 5,
  zip_threshold_edit_file: 5,
  zip_threshold_execute_command: 5,
  zip_threshold_list_files: 5,
  zip_threshold_all_other_tools: 5,
  auto_zip_error: true,
  auto_zip_image: false,
  auto_zip_subagent: true,
  auto_zip_read_file: true,
  auto_zip_write_file: true,
  auto_zip_edit_file: true,
  auto_zip_execute_command: true,
  auto_zip_list_files: true,
  auto_zip_all_other_tools: true,
  zip_disabled_error: true,
  zip_disabled_image: true,
  zip_disabled_subagent: true,
  zip_disabled_read_file: true,
  zip_disabled_write_file: true,
  zip_disabled_edit_file: true,
  zip_disabled_execute_command: true,
  zip_disabled_list_files: true,
  zip_disabled_all_other_tools: true,
  custom_tool_settings: [{ tool_name: 'tool_r', buffer_size: 4 }]
}

describe('every zip field the save can name is sent when it changes (BL-855)', () => {
  const fields = Object.keys(CHANGE_ONE_ZIP_FIELD) as (keyof ZipPayloadBody)[]

  it('the table names every key the payload builder returns', () => {
    expect([...fields].sort()).toEqual(Object.keys(zipBase()).sort())
  })

  for (const field of fields) {
    it(`a change to ${field} is sent alone, and taken out again is sent as its inherit value`, () => {
      const changed = { ...zipBase(), [field]: CHANGE_ONE_ZIP_FIELD[field] }
      expect(diffZipPayload(zipBase(), changed)).toEqual({ [field]: CHANGE_ONE_ZIP_FIELD[field] })
      const back = diffZipPayload(changed, zipBase())
      expect(back).toEqual({ [field]: field === 'custom_tool_settings' ? [] : null })
    })
  }
})

/** One entry per key of the Codex block: a change to it. */
const CHANGE_ONE_CODEX_KEY: { [K in keyof CodexAgentSettings]-?: CodexAgentSettings[K] } = {
  mode4Style: 'cli',
  permissionMode: 'agent',
  includeProjectInstructions: false,
  model: 'gpt-6-sol',
  profileId: 'profile_x',
  reasoningEffort: 'high',
  modelVerbosity: 'high',
  serviceTier: 'fast',
  streamingEffect: false,
  search: false,
  sandbox: 'workspace-write',
  approval: 'on-request',
  addDirs: ['/one'],
  enableFeatures: ['feature_a'],
  disableFeatures: ['feature_b'],
  configOverrides: [{ key: 'model_context_window', value: '1000' }],
  workingDirectoryMode: 'custom',
  customWorkingDirectory: '/work',
  configScope: 'global',
  unifiedExec: false,
  historyPersistence: 'save-all'
}

const CHANGE_ONE_CLAUDE_KEY: { [K in keyof ClaudeAgentSettings]-?: ClaudeAgentSettings[K] } = {
  mode4Style: 'cli',
  permissionMode: 'plan',
  profileId: 'profile_x',
  includeCoreSystemPrompt: true,
  includeProjectInstructions: false,
  model: 'opus',
  alwaysThinkingEnabled: true,
  maxThinkingTokens: 4000,
  configScope: 'global',
  systemPromptMode: 'default',
  systemPrompt: 'A prompt.',
  systemPromptFile: 'prompt.md',
  chrome: true,
  addDirs: ['/one'],
  allowedTools: ['Read'],
  disallowedTools: ['Bash'],
  configOverrides: [{ key: 'env.X', value: '1' }],
  workingDirectoryMode: 'custom',
  customWorkingDirectory: '/work'
}

const CODEX_BLOCK: CodexAgentSettings = {
  permissionMode: 'chat',
  model: 'gpt-6-astra',
  streamingEffect: true,
  search: true,
  sandbox: 'read-only',
  approval: 'never',
  addDirs: [],
  enableFeatures: [],
  disableFeatures: [],
  configOverrides: [],
  workingDirectoryMode: 'project'
}

const CLAUDE_BLOCK: ClaudeAgentSettings = {
  permissionMode: 'acceptEdits',
  addDirs: [],
  allowedTools: [],
  disallowedTools: [],
  configOverrides: []
}

describe('every Codex and Claude key the sections can name is sent when it changes (BL-848)', () => {
  for (const key of Object.keys(CHANGE_ONE_CODEX_KEY) as (keyof CodexAgentSettings)[]) {
    it(`codex_settings.${key}: a change is sent alone, and a dropped key goes as null`, () => {
      const value = CHANGE_ONE_CODEX_KEY[key]
      const changed = { ...CODEX_BLOCK, [key]: value }
      // A required key that already held another value is replaced; a key the block lacks is added.
      expect(diffAgentBlock('codex_settings', CODEX_BLOCK, changed)).toEqual({ [key]: value })
      // The same key dropped from the form (an optional one, or one the block lacked) is named as null.
      const { [key]: _removed, ...without } = changed as Record<string, unknown>
      expect(diffAgentBlock('codex_settings', changed, without)).toEqual({ [key]: null })
    })
  }

  for (const key of Object.keys(CHANGE_ONE_CLAUDE_KEY) as (keyof ClaudeAgentSettings)[]) {
    it(`claude_settings.${key}: a change is sent alone, and a dropped key goes as null`, () => {
      const value = CHANGE_ONE_CLAUDE_KEY[key]
      const changed = { ...CLAUDE_BLOCK, [key]: value }
      expect(diffAgentBlock('claude_settings', CLAUDE_BLOCK, changed)).toEqual({ [key]: value })
      const { [key]: _removed, ...without } = changed as Record<string, unknown>
      expect(diffAgentBlock('claude_settings', changed, without)).toEqual({ [key]: null })
    })
  }

  it('an agent with no block yet gets every key the form names (the block is created whole)', () => {
    expect(diffAgentBlock('codex_settings', null, CODEX_BLOCK)).toEqual(CODEX_BLOCK)
    expect(diffAgentBlock('claude_settings', null, CLAUDE_BLOCK)).toEqual(CLAUDE_BLOCK)
  })

  it('a form that changed nothing sends nothing, and a key that stays undefined is not named', () => {
    expect(diffAgentBlock('codex_settings', CODEX_BLOCK, { ...CODEX_BLOCK, reasoningEffort: undefined })).toBeUndefined()
    expect(diffAgentBlock('claude_settings', CLAUDE_BLOCK, { ...CLAUDE_BLOCK })).toBeUndefined()
  })
})
