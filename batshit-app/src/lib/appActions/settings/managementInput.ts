import { validateAutoCompactChanges, type AutoCompactChanges } from './autoCompactPreferences'
import { validateConfiguredTtsChanges, validTtsId, parseConfiguredFishAccountQuery, isConfiguredFishAccountCursor, type ConfiguredTtsChanges } from './configuredTtsPreferences'
import { validateInstructionsChanges, type InstructionsChanges } from './instructionPreferences'
import { validateModelSelectionChanges, validateModelPresetCopyChanges, type ModelPresetCopyChanges, type ModelSelectionChanges } from './modelSelectionPreferences'
import { parseSettingsReportRequest, parseSettingsSubjectSelector, reportObject } from './reportContract'
import { validateIdentityChanges, validateMemoryChanges, type IdentityPreferenceChanges, type MemoryPreferenceChanges } from './validation'
import { SETTINGS_REPORT_IDS, SETTINGS_CHANGE_IDS, settingsChangeProperties, type SettingsChangeId } from './definitions'
import { parseSkillAccessQuery, parseSkillAccessChange, SKILL_ACCESS_INPUT_LIMIT, type SkillAccessChange } from '$lib/appActions/skillAccess'
import { validateApiPresentationChanges, validateApiRetentionChanges, type ApiPresentationChanges, type ApiRetentionChanges } from './apiReasoningPreferences'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_DOMAIN, parseMcpConfigurationChanges, parseMcpConfigurationQuery, isMcpReportId, isMcpOperationId, type McpConfigurationChanges } from './mcpConfiguration'

export type ManagedSettingsChangeInput = {
  op: 'change'; requestId: string; reportId: string; semanticId: SettingsChangeId | typeof MCP_CONFIGURATION_ID
  changes: ConfiguredTtsChanges | AutoCompactChanges | IdentityPreferenceChanges | MemoryPreferenceChanges | ApiPresentationChanges | ApiRetentionChanges | SkillAccessChange | ModelSelectionChanges | ModelPresetCopyChanges | InstructionsChanges | McpConfigurationChanges; hardDeadlineAt?: number
} | { op: 'outcome' | 'cancel'; operationId: string; outcomeOffset?: number }
export const SETTINGS_CHANGE_PARSERS = Object.freeze({
  'agent.voice.tts-selection': validateConfiguredTtsChanges,
  'agent.context.auto-compact': validateAutoCompactChanges,
  'agent.instructions': validateInstructionsChanges,
  'agent.model.selection': validateModelSelectionChanges,
  'agent.model.preset-copy': validateModelPresetCopyChanges,
  'agent.identity': validateIdentityChanges, 'agent.memory.preferences': validateMemoryChanges,
  'agent.reasoning.presentation': validateApiPresentationChanges, 'agent.reasoning.retention': validateApiRetentionChanges,
  'agent.skills.access': parseSkillAccessChange
} satisfies Record<SettingsChangeId, (input: unknown) => unknown>)
export function parseManagedSettingsReportInput(input: unknown): Record<string, unknown> {
  const args = reportObject(input, ['domain', 'targets', 'focus', 'query', 'detail', 'reportId', 'cursor'])
  if (args.reportId !== undefined) {
    if (typeof args.reportId !== 'string' || !/^asr_[a-f0-9]{24}_[a-f0-9]{32}$/.test(args.reportId) && !isMcpReportId(args.reportId) ||
      Object.keys(args).some(key => key !== 'reportId' && key !== 'cursor')) throw new Error('Invalid report continuation.')
    if (isMcpReportId(args.reportId)) {
      if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^mcp1:[a-f0-9]{32}:(?:0|[1-9][0-9]{0,2})$/.test(args.cursor))) throw new Error('Invalid MCP report cursor.')
    } else if (args.cursor !== undefined && !isConfiguredFishAccountCursor(args.cursor)) parseSettingsReportRequest({ cursor: args.cursor })
    return args
  }
  if (args.cursor !== undefined) throw new Error('A cursor requires reportId.')
  if (args.domain === MCP_CONFIGURATION_DOMAIN) {
    if (args.targets !== undefined || args.focus !== undefined) throw new Error('MCP configuration describes a user-owned resource, not an agent target.')
    parseSettingsReportRequest({ ...(args.detail !== undefined ? { detail: args.detail } : {}) })
    return { ...args, query: parseMcpConfigurationQuery(args.query ?? { kind: 'sources' }) }
  }
  if (args.domain !== undefined && args.domain !== 'agent-settings' && args.domain !== 'skill-access' && args.domain !== 'runtime-inspection') throw new Error('Invalid App Actions report domain.')
  if (args.domain === 'runtime-inspection') {
    if (Object.keys(args).some(key => key !== 'domain')) throw new Error('Runtime inspection accepts no subjects, settings, report or operation.')
    return args
  }
  if (args.targets !== undefined) parseSettingsSubjectSelector(args.targets)
  if (args.domain === 'skill-access') {
    if (args.focus !== undefined) throw new Error('Skill access uses its finite skill query, not Settings field focus.')
    parseSettingsReportRequest({ ...(args.detail !== undefined ? { detail: args.detail } : {}) })
    return { ...args, query: parseSkillAccessQuery(args.query ?? {}) }
  }
  if (args.query !== undefined) {
    const query = reportObject(args.query, ['sourcePresetId', 'presetText', 'presetOffset', 'instructionText', 'ttsCatalog', 'ttsProviderId', 'ttsModelId', 'ttsProfileId', 'ttsOffset'])
    if (query.sourcePresetId !== undefined) {
      validateModelSelectionChanges({ presetId: query.sourcePresetId })
      if (Object.keys(query).length !== 1 || args.detail !== 'choices' || !Array.isArray(args.focus) || args.focus.length !== 1 || args.focus[0] !== 'agent.model.preset-copy') throw new Error('Copy choices require one explicit original preset and copy-only focus.')
      parseSettingsReportRequest({ focus: args.focus, detail: args.detail })
      return args
    }
    if (query.ttsCatalog !== undefined) {
      const account = parseConfiguredFishAccountQuery(query)
      const targets = args.targets === undefined ? undefined : parseSettingsSubjectSelector(args.targets)
      const rawTargets = args.targets && typeof args.targets === 'object' ? (args.targets as Record<string, unknown>).subjects : undefined
      if (args.detail !== 'choices' || !Array.isArray(args.focus) || args.focus.length !== 1 || args.focus[0] !== 'agent.voice.tts-selection' ||
          !targets || !('subjects' in targets) || targets.subjects.length !== 1 || targets.subjects[0].kind !== 'primary' || !Array.isArray(rawTargets) || rawTargets.length !== 1) {
        throw new Error('Fish account choices require exactly one explicit Primary subject and reply-voice-only choices.')
      }
      return { ...args, query: account }
    }
    if (Object.keys(query).some(key => key.startsWith('tts'))) {
      if (args.detail !== 'choices' || !Array.isArray(args.focus) || args.focus.length !== 1 || args.focus[0] !== 'agent.voice.tts-selection' ||
        Object.keys(query).some(key => !['ttsProviderId', 'ttsModelId', 'ttsProfileId', 'ttsOffset'].includes(key)) ||
        ['ttsProviderId', 'ttsModelId', 'ttsProfileId'].some(key => query[key] !== undefined && !validTtsId(query[key])) ||
        query.ttsOffset !== undefined && (!Number.isSafeInteger(query.ttsOffset) || Number(query.ttsOffset) < 0 || Number(query.ttsOffset) > 10000)) throw new Error('Reply voice choices require their finite configured-source query.')
    } else if (query.instructionText !== undefined) {
      const targets = args.targets === undefined ? undefined : parseSettingsSubjectSelector(args.targets)
      if (query.instructionText !== true || Object.keys(query).length !== 1 || args.detail !== 'values' || !Array.isArray(args.focus) ||
        args.focus.length !== 1 || args.focus[0] !== 'agent.instructions' || !targets || !('subjects' in targets) || targets.subjects.length !== 1) {
        throw new Error('Full instruction text requires an explicit single granted subject, instructions-only focus and values detail.')
      }
    } else if (args.detail !== 'choices' || !Array.isArray(args.focus) || args.focus.length !== 1 || args.focus[0] !== 'agent.model.selection' ||
      query.presetText !== undefined && (typeof query.presetText !== 'string' || query.presetText.length > 128 || !query.presetText.isWellFormed()) ||
      query.presetOffset !== undefined && (typeof query.presetOffset !== 'number' || !Number.isSafeInteger(query.presetOffset) || query.presetOffset < 0 || query.presetOffset > 10000)) throw new Error('Preset choices accept a bounded text filter and offset with model-selection focus only.')
  }
  if (Array.isArray(args.focus) && args.focus.includes('agent.model.preset-copy')) throw new Error('Copy requires its explicit original-source choices read.')
  parseSettingsReportRequest({ ...(args.focus !== undefined ? { focus: args.focus } : {}), ...(args.detail !== undefined ? { detail: args.detail } : {}) })
  return args
}
export function parseManagedSettingsChangeInput(input: unknown): ManagedSettingsChangeInput {
  const args = reportObject(input, ['op', 'requestId', 'reportId', 'semanticId', 'changes', 'hardDeadlineAt', 'operationId', 'outcomeOffset'])
  if (args.op === 'outcome' || args.op === 'cancel') {
    if (Object.keys(args).some(key => key !== 'op' && key !== 'operationId' && key !== 'outcomeOffset') || typeof args.operationId !== 'string' || !/^aso_[a-f0-9]{24}_[a-f0-9]{32}$/.test(args.operationId) && !isMcpOperationId(args.operationId) ||
      args.outcomeOffset !== undefined && (args.op !== 'outcome' || typeof args.outcomeOffset !== 'number' || !Number.isSafeInteger(args.outcomeOffset) || args.outcomeOffset < 0 || args.outcomeOffset > 256)) throw new Error('Invalid operation lookup.')
    return { op: args.op, operationId: args.operationId, ...(args.outcomeOffset !== undefined ? { outcomeOffset: args.outcomeOffset as number } : {}) }
  }
  if (args.op !== 'change' || args.operationId !== undefined || args.outcomeOffset !== undefined || typeof args.requestId !== 'string' || !/^[a-f0-9]{24}:[A-Za-z0-9_.:-]{1,128}$/.test(args.requestId) ||
    typeof args.reportId !== 'string' || !/^asr_[a-f0-9]{24}_[a-f0-9]{32}$/.test(args.reportId) && !isMcpReportId(args.reportId) ||
    typeof args.semanticId !== 'string' || !(SETTINGS_CHANGE_IDS as readonly string[]).includes(args.semanticId) && args.semanticId !== MCP_CONFIGURATION_ID ||
    args.hardDeadlineAt !== undefined && (typeof args.hardDeadlineAt !== 'number' || !Number.isSafeInteger(args.hardDeadlineAt))) throw new Error('Invalid Settings change request.')
  if (args.semanticId === MCP_CONFIGURATION_ID) {
    if (!isMcpReportId(args.reportId)) throw new Error('Use the exact held MCP resource report.')
    return { op: 'change', requestId: args.requestId, reportId: args.reportId, semanticId: MCP_CONFIGURATION_ID,
      changes: parseMcpConfigurationChanges(args.changes), ...(typeof args.hardDeadlineAt === 'number' ? { hardDeadlineAt: args.hardDeadlineAt } : {}) }
  }
  if (isMcpReportId(args.reportId)) throw new Error('An MCP report cannot grant an agent Settings change.')
  return { op: 'change', requestId: args.requestId, reportId: args.reportId, semanticId: args.semanticId as SettingsChangeId,
    changes: SETTINGS_CHANGE_PARSERS[args.semanticId as SettingsChangeId](args.changes),
    ...(typeof args.hardDeadlineAt === 'number' ? { hardDeadlineAt: args.hardDeadlineAt } : {}) }
}
/** Delivered base metadata stays exact for ordinary/CLI/portable callers. Genuine
 * original API discovery projects the finite HTTP/saved-installed-STDIO metadata below; actual Fabric
 * dispatch still uses the shared bounded parseManagedSettings* validators above. */
export const MANAGED_SETTINGS_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    domain: { type: 'string', enum: ['agent-settings', 'skill-access', 'runtime-inspection'], description: 'Omitted: agent settings. Runtime inspection is instance-only and accepts no targets. Continue any held report with reportId and cursor only.' },
    query: { type: 'object', additionalProperties: false, properties: { sourcePresetId: { type: 'string', maxLength: 256, description: 'Explicit original preset for copy-only choices; never a destination or source capability.' }, skillIds: { type: 'array', minItems: 1, maxItems: SKILL_ACCESS_INPUT_LIMIT, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9_]{1,128}$' } }, presetText: { type: 'string', maxLength: 128 }, presetOffset: { type: 'integer', minimum: 0, maximum: 10000 }, instructionText: { type: 'boolean', const: true }, ttsCatalog: { type: 'string', enum: ['account'] }, ttsProviderId: { type: 'string', maxLength: 256 }, ttsModelId: { type: 'string', maxLength: 256 }, ttsProfileId: { type: 'string', maxLength: 256 }, ttsOffset: { type: 'integer', minimum: 0, maximum: 10000 } }, description: 'Skill access uses skillIds. Model choices use presetText/presetOffset. Fish account choices require ttsCatalog:account, ttsProviderId:fish, optional ttsModelId, exactly one explicit Primary, reply-voice-only choices. Omitted ttsCatalog remains local; ttsOffset never fetches a provider. Continue issued account pages with reportId/cursor only. Full instruction text requires its explicit single-subject values query; default reports contain metadata only.' },
    targets: { type: 'object', description: 'Explicit typed subjects or allAgents:true with typed except IDs; bounded immutable report manifest.' },
    focus: { type: 'array', items: { type: 'string', enum: SETTINGS_REPORT_IDS }, maxItems: SETTINGS_REPORT_IDS.length },
    detail: { type: 'string', enum: ['summary', 'values', 'choices'] }, reportId: { type: 'string' }, cursor: { type: 'string' }
  }
} as const
const PRESET_PARAMETER_EDITS_SCHEMA = { type: 'array', minItems: 1, maxItems: 32, items: { oneOf: [
  { type: 'object', additionalProperties: false, required: ['name', 'op'], properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, op: { type: 'string', const: 'unset' } } },
  { type: 'object', additionalProperties: false, required: ['name', 'op', 'value'], properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, op: { type: 'string', const: 'set' }, value: { anyOf: [
    { type: 'string', maxLength: 2048 }, { type: 'number' }, { type: 'boolean' },
    { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2048 } }, { type: 'array', maxItems: 64, items: { type: 'number' } }
  ] } } }
] }, description: 'Only fields offered by the held original preset copy choices. Strict model-supported types/ranges apply; unset deletes that field, zero and false are real. No raw Custom Parameters.' } as const
export const MANAGED_SETTINGS_CHANGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['op'], properties: {
    op: { type: 'string', enum: ['change', 'outcome', 'cancel'] }, requestId: { type: 'string', description: 'Current report bootNamespace plus colon and a unique request ID; never reuse for a different intent.' },
    reportId: { type: 'string', description: 'Held report fixes every subject, exclusion and saved preimage; no caller-added target.' },
    semanticId: { type: 'string', enum: SETTINGS_CHANGE_IDS },
    changes: { type: 'object', additionalProperties: false, properties: { ...settingsChangeProperties(), parameters: PRESET_PARAMETER_EDITS_SCHEMA, assignments: { type: 'array', minItems: 1, maxItems: SKILL_ACCESS_INPUT_LIMIT, items: { type: 'object', additionalProperties: false, required: ['skillId', 'enabled'], properties: { skillId: { type: 'string', pattern: '^[a-z0-9_]{1,128}$' }, enabled: { type: 'boolean' } } } }, universalConversion: { type: 'string', enum: ['preserve-current-population'] } } }, operationId: { type: 'string' }, outcomeOffset: { type: 'integer', minimum: 0, maximum: 256, description: 'Continue the bounded outcome page for this exact operation; never starts a new write.' },
    hardDeadlineAt: { type: 'integer', description: 'Optional caller hard deadline as Unix milliseconds; approval cannot extend it.' }
  }
} as const

/** Descriptive API-only HTTP prerequisite metadata. The shared bounded parsers
 * above remain the sole dispatch validators; these schemas grant no authority. */
const MCP_METADATA_ID = { type: 'string', minLength: 1, maxLength: 128 } as const
const MCP_METADATA_SUBJECT = { type: 'object', additionalProperties: false, required: ['kind', 'id'],
  properties: { kind: { type: 'string', const: 'primary' }, id: MCP_METADATA_ID } } as const
const MCP_METADATA_ZIP_NUMBERS = {
  bufferSize: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  zipThreshold: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
} as const
const MCP_METADATA_ZIP = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['toolName', 'mode'], properties: {
    toolName: { type: 'string', minLength: 1, maxLength: 256 }, mode: { type: 'string', const: 'inherit' }
  } },
  { type: 'object', additionalProperties: false, required: ['toolName', 'mode'], properties: {
    toolName: { type: 'string', minLength: 1, maxLength: 256 }, mode: { type: 'string', enum: ['normal', 'auto', 'off'] }, ...MCP_METADATA_ZIP_NUMBERS
  } },
  { type: 'object', additionalProperties: false, required: ['toolName'], minProperties: 2, properties: {
    toolName: { type: 'string', minLength: 1, maxLength: 256 }, ...MCP_METADATA_ZIP_NUMBERS,
    autoZip: { type: ['boolean', 'null'] }, zipDisabled: { type: ['boolean', 'null'] }
  } }
], description: 'Exact original MCP tool name, not a guessed collision alias. Explicit zero threshold/false/inherit/no-op still requests Context authority. Null removes only that override. Never mix mode with booleans or inherit with numeric fields.' } as const
const MCP_METADATA_REMOVAL_ZIP = { oneOf: [
  MCP_METADATA_ZIP.oneOf[0],
  { type: 'object', additionalProperties: false, required: ['toolName'], minProperties: 2, properties: {
    toolName: { type: 'string', minLength: 1, maxLength: 256 }, bufferSize: { type: 'null' }, zipThreshold: { type: 'null' }, autoZip: { type: 'null' }, zipDisabled: { type: 'null' }
  } }
] } as const
const MCP_METADATA_NEW_TARGET = { type: 'object', additionalProperties: false, required: ['subject', 'membership'], properties: {
  subject: MCP_METADATA_SUBJECT, membership: { type: 'string', const: 'enable' }, zip: MCP_METADATA_ZIP
}, description: 'New HTTP source has no caller gatewayId; copy the server-assigned gatewayId into the later change target. Only a self-target verified addition can join this original task; other owned Primary changes do not grant the actor tool access.' } as const
const MCP_METADATA_TARGET = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['subject', 'gatewayId', 'membership'], properties: {
    subject: MCP_METADATA_SUBJECT, gatewayId: MCP_METADATA_ID, membership: { type: 'string', const: 'enable' }, zip: MCP_METADATA_ZIP
  } },
  { type: 'object', additionalProperties: false, required: ['subject', 'gatewayId', 'membership'], properties: {
    subject: MCP_METADATA_SUBJECT, gatewayId: MCP_METADATA_ID, membership: { type: 'string', const: 'disable' }, zip: MCP_METADATA_REMOVAL_ZIP
  } }
] } as const
const MCP_METADATA_HTTP = { type: 'object', additionalProperties: false, required: ['kind', 'name', 'url', 'evidence'], properties: {
  kind: { type: 'string', const: 'http' }, name: { type: 'string', minLength: 1, maxLength: 200 },
  url: { type: 'string', minLength: 1, maxLength: 2048, description: 'HTTP(S) endpoint without embedded credentials, query or fragment.' },
  savedKeyRef: { ...MCP_METADATA_ID, description: 'Existing saved-key reference name only, never its value. Omit only for a genuinely unauthenticated source; missing/unreadable required keys never fall back to no authentication.' },
  evidence: { type: 'object', additionalProperties: false, required: ['kind', 'uri'], properties: {
    kind: { type: 'string', enum: ['supplied', 'researched'] }, uri: { type: 'string', minLength: 1, maxLength: 2048 },
    version: { ...MCP_METADATA_ID, pattern: '^(?:[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?|[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$' }
  } }
} } as const
const MCP_METADATA_QUERY = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', const: 'sources' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'gatewayId'], properties: { kind: { type: 'string', const: 'details' }, gatewayId: MCP_METADATA_ID } },
  { type: 'object', additionalProperties: false, required: ['kind', 'candidate', 'target'], properties: { kind: { type: 'string', const: 'prerequisite' }, candidate: MCP_METADATA_HTTP, target: MCP_METADATA_NEW_TARGET } },
  { type: 'object', additionalProperties: false, required: ['kind', 'target'], properties: { kind: { type: 'string', const: 'prerequisite' }, target: MCP_METADATA_TARGET } }
], description: 'One complete custom HTTP or already-installed saved STDIO source/owned selection/explicit Zip intent. For saved STDIO use sources/details then target.gatewayId; no command, argv, env value or new STDIO candidate. Only unchanged saved executable/local-entry launch with none/fixed cwd and saved env refs is admitted; enabled:false→true is fully reviewed. Package runners and project cwd are unsupported here; no package/install/profile/account action is offered. Docker Toolkit and n8n administration are outside this feature; an already-running service qualifies only by its actual admitted custom HTTP source/ref shape. Removal never contacts a source.' } as const
export const API_MANAGED_SETTINGS_REPORT_SCHEMA = { oneOf: [MANAGED_SETTINGS_REPORT_SCHEMA, {
  type: 'object', additionalProperties: false, required: ['domain', 'query'], properties: {
    domain: { type: 'string', const: MCP_CONFIGURATION_DOMAIN }, query: MCP_METADATA_QUERY,
    detail: MANAGED_SETTINGS_REPORT_SCHEMA.properties.detail
  }
}], description: 'Original Primary only: read this full schema, then request the exact prerequisite report. Continue any held report with reportId/cursor only. A report or saved-key presence is not verification or continuation authority.' } as const
export const API_MANAGED_SETTINGS_CHANGE_SCHEMA = { oneOf: [MANAGED_SETTINGS_CHANGE_SCHEMA, {
  type: 'object', additionalProperties: false, required: ['op', 'requestId', 'reportId', 'semanticId', 'changes'], properties: {
    op: { type: 'string', const: 'change' }, requestId: MANAGED_SETTINGS_CHANGE_SCHEMA.properties.requestId,
    reportId: { type: 'string', pattern: '^asr_[a-f0-9]{24}_mcp_[a-f0-9]{32}$' }, semanticId: { type: 'string', const: MCP_CONFIGURATION_ID },
    changes: { type: 'object', additionalProperties: false, required: ['target'], properties: {
      source: { type: 'object', additionalProperties: false, required: ['candidateId'], properties: { candidateId: { type: 'string', pattern: '^mcpc_[a-f0-9]{32}$' } } }, target: MCP_METADATA_TARGET
    }, description: 'Copy the held target and assigned gatewayId exactly; new source requires its returned candidateId. No caller approval/ready/key values.' },
    hardDeadlineAt: MANAGED_SETTINGS_CHANGE_SCHEMA.properties.hardDeadlineAt
  }
}], description: 'One exact held operation and full approval. Wait for the server-owned fresh continuation; Search/Find and use its exact returned C ref. Saved/verified/selected/Zip/use are separate facts. For unknown outcomes inspect this operation; never reissue a new write or widen original []/A with saved defaults.' } as const
