import { describe, expect, it } from 'vitest'
import { agentUpdateScriptArguments, planAgentRecordUpdate } from '$lib/server/agentRecordUpdate'
import { agentTypeSnapshotOf, runAgentUpdateScriptTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import {
  AGENT_FIELD_BY_FIELD_BLOCKS,
  AGENT_SETTINGS_KEY_GROUPS,
  AgentBlockShapeError,
  CLAUDE_THINKING_GROUP,
  CODEX_PERMISSION_GROUP,
  applyAgentBlockUpdate,
  diffAgentBlock,
  diffAgentBlockWithGroups,
  isAgentFieldByFieldBlock,
  planAgentBlockWrite,
  sameJsonValue,
  type AgentFieldByFieldBlock
} from './agentBlockFieldSettings'

/**
 * BL-848, BL-855: the one place that knows how a save of `codex_settings`, `claude_settings` and
 * `dcmDisplaySettings` is written field by field. The server plan (`planAgentRecordUpdate`), the
 * agents store's copy (`applyAgentBlockUpdate`) and every control that sends one of these blocks
 * (`diffAgentBlock`) agree by construction; the cases below run through the server plan and the
 * default lane's twin of the real script too, so a rule that drifts fails here.
 */

const CODEX = { model: 'gpt-5', permissionMode: 'chat', sandbox: 'workspace-write', addDirs: ['/a', '/b'], configOverrides: [{ key: 'model_verbosity', value: 'low' }] }
const CLAUDE = { model: 'sonnet', permissionMode: 'default', alwaysThinkingEnabled: false, addDirs: ['/a'] }
const DCM = {
  version: 1,
  groups: { gw_a: 'group-only', gw_b: 'hidden' },
  tools: { 'gw_a::read': 'name-only' },
  groupDisplayPreferences: { gw_a: 'group-only' },
  toolDisplayPreferences: { 'gw_a::read': 'name+hint' }
}

describe('the three field-by-field blocks', () => {
  it('names codex_settings, claude_settings and dcmDisplaySettings, and nothing else', () => {
    expect([...AGENT_FIELD_BY_FIELD_BLOCKS]).toEqual(['codex_settings', 'claude_settings', 'dcmDisplaySettings'])
    for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) expect(isAgentFieldByFieldBlock(field)).toBe(true)
    for (const other of ['provider_specific_settings', 'defaultMCPGateways', 'defaultTools', 'defaultMCPToolSelections', 'custom_tool_settings']) {
      expect(isAgentFieldByFieldBlock(other)).toBe(false)
    }
  })
})

describe('planAgentBlockWrite: the steps of a save', () => {
  it('a codex or claude save: the block made an object, each key set, a null key removed, an undefined key skipped', () => {
    expect(planAgentBlockWrite('codex_settings', { model: 'gpt-6', sandbox: null, search: undefined, addDirs: ['/c'] })).toEqual({
      kind: 'steps',
      steps: [
        { step: 'ensure', path: [] },
        { step: 'set', path: ['model'], value: 'gpt-6' },
        { step: 'delete', path: ['sandbox'] },
        { step: 'set', path: ['addDirs'], value: ['/c'] }
      ]
    })
    expect(planAgentBlockWrite('claude_settings', { permissionMode: 'plan' })).toEqual({
      kind: 'steps',
      steps: [
        { step: 'ensure', path: [] },
        { step: 'set', path: ['permissionMode'], value: 'plan' }
      ]
    })
  })

  it('removals alone, {} and no block make nothing (the block is never created by a save that sets nothing)', () => {
    expect(planAgentBlockWrite('codex_settings', { model: null, sandbox: null })).toEqual({
      kind: 'steps',
      steps: [
        { step: 'delete', path: ['model'] },
        { step: 'delete', path: ['sandbox'] }
      ]
    })
    expect(planAgentBlockWrite('codex_settings', {})).toEqual({ kind: 'steps', steps: [] })
    expect(planAgentBlockWrite('codex_settings', undefined)).toEqual({ kind: 'steps', steps: [] })
  })

  it('the block sent as null is a whole write of null', () => {
    for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) expect(planAgentBlockWrite(field, null)).toEqual({ kind: 'whole', value: null })
  })

  it('dcmDisplaySettings: version, then each map made an object right before its own entries', () => {
    expect(
      planAgentBlockWrite('dcmDisplaySettings', {
        version: 1,
        groups: { gw_a: 'hidden', gw_b: null },
        tools: { 'gw_a::read': null },
        toolDisplayPreferences: { 'gw_a::read': 'inherit' }
      })
    ).toEqual({
      kind: 'steps',
      steps: [
        { step: 'ensure', path: [] },
        { step: 'set', path: ['version'], value: 1 },
        { step: 'ensure', path: ['groups'] },
        { step: 'set', path: ['groups', 'gw_a'], value: 'hidden' },
        { step: 'delete', path: ['groups', 'gw_b'] },
        { step: 'delete', path: ['tools', 'gw_a::read'] },
        { step: 'ensure', path: ['toolDisplayPreferences'] },
        { step: 'set', path: ['toolDisplayPreferences', 'gw_a::read'], value: 'inherit' }
      ]
    })
  })

  it('dcmDisplaySettings: a map of removals or {} is not made, a map sent null is removed, an undefined entry is skipped', () => {
    expect(planAgentBlockWrite('dcmDisplaySettings', { groups: { gw_a: null }, tools: {}, groupDisplayPreferences: null, toolDisplayPreferences: { x: undefined } })).toEqual({
      kind: 'steps',
      steps: [
        { step: 'delete', path: ['groups', 'gw_a'] },
        { step: 'delete', path: ['groupDisplayPreferences'] }
      ]
    })
  })

  it('a key of dcmDisplaySettings that is not a map is written whole, an object value included', () => {
    expect(planAgentBlockWrite('dcmDisplaySettings', { future: { a: 1 } })).toEqual({
      kind: 'steps',
      steps: [
        { step: 'ensure', path: [] },
        { step: 'set', path: ['future'], value: { a: 1 } }
      ]
    })
  })

  it('a block, or a dcmDisplaySettings map, that is neither an object nor null is refused with the setting named', () => {
    for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) {
      for (const bad of ['oops', ['a'], 5, true]) {
        expect(() => planAgentBlockWrite(field, bad)).toThrow(AgentBlockShapeError)
        expect(() => planAgentBlockWrite(field, bad)).toThrow(new RegExp(`"${field}"[\\s\\S]*must be an object or null`))
      }
    }
    for (const bad of ['oops', ['a'], 5, true]) {
      expect(() => planAgentBlockWrite('dcmDisplaySettings', { groups: bad })).toThrow(/"groups"[\s\S]*must be an object or null/)
    }
  })
})

/** [field, stored copy, save, the block after the save]. `undefined` is a copy with no block. */
type Case = [AgentFieldByFieldBlock, unknown, unknown, unknown]

const APPLY_CASES: Record<string, Case> = {
  'codex: named keys are written, a null key is removed, the rest stays, a list is whole': [
    'codex_settings',
    CODEX,
    { model: 'gpt-6', sandbox: null, addDirs: ['/c'], search: true },
    { model: 'gpt-6', permissionMode: 'chat', addDirs: ['/c'], configOverrides: CODEX.configOverrides, search: true }
  ],
  'claude: a partial save over a full copy': ['claude_settings', CLAUDE, { permissionMode: 'plan' }, { ...CLAUDE, permissionMode: 'plan' }],
  'a copy with no block takes the named keys': [
    'codex_settings',
    undefined,
    { model: 'gpt-6' },
    { model: 'gpt-6' }
  ],
  'a copy that is null takes the named keys': ['codex_settings', null, { model: 'gpt-6' }, { model: 'gpt-6' }],
  'a copy that is not an object is replaced by an object of the named keys': ['claude_settings', 'garbage', { model: 'opus' }, { model: 'opus' }],
  'removals alone leave a copy with no block as it is': ['codex_settings', undefined, { model: null }, undefined],
  'removals alone leave a null copy as it is': ['codex_settings', null, { model: null }, null],
  'removals alone leave a copy that is not an object as it is': ['codex_settings', 'garbage', { model: null }, 'garbage'],
  '{} writes nothing': ['codex_settings', CODEX, {}, CODEX],
  'no block sent writes nothing': ['codex_settings', CODEX, undefined, CODEX],
  'the block sent as null is null': ['codex_settings', CODEX, null, null],
  'removing the last key leaves an empty block': ['claude_settings', { model: 'sonnet' }, { model: null }, {}],
  'dcm: entries are written by map, an entry named null is removed, version and the other maps stay': [
    'dcmDisplaySettings',
    DCM,
    { groups: { gw_a: 'hidden', gw_b: null, gw_c: 'group-only' }, tools: { 'gw_a::write': 'hidden' } },
    { ...DCM, groups: { gw_a: 'hidden', gw_c: 'group-only' }, tools: { 'gw_a::read': 'name-only', 'gw_a::write': 'hidden' } }
  ],
  'dcm: a map sent whole is written entry by entry, an entry it does not name stays': [
    'dcmDisplaySettings',
    DCM,
    { groups: { gw_a: 'hidden' } },
    { ...DCM, groups: { gw_a: 'hidden', gw_b: 'hidden' } }
  ],
  'dcm: a map sent null is removed; {} leaves a map as it is': ['dcmDisplaySettings', DCM, { groups: null, tools: {} }, { ...DCM, groups: undefined }],
  'dcm: the last entry of a map removed leaves an empty map': ['dcmDisplaySettings', { version: 1, tools: { t: 'hidden' } }, { tools: { t: null } }, { version: 1, tools: {} }],
  'dcm: a copy with no block takes the block and the map': ['dcmDisplaySettings', undefined, { groups: { gw_a: 'hidden' } }, { groups: { gw_a: 'hidden' } }],
  'dcm: a map that is null or not an object is made an object when an entry is set': [
    'dcmDisplaySettings',
    { version: 1, groups: 'garbage', tools: null },
    { groups: { gw_a: 'hidden' }, tools: { t: 'hidden' } },
    { version: 1, groups: { gw_a: 'hidden' }, tools: { t: 'hidden' } }
  ],
  'dcm: removals in a map that is not an object leave it as it is': [
    'dcmDisplaySettings',
    { version: 1, groups: 'garbage' },
    { groups: { gw_a: null } },
    { version: 1, groups: 'garbage' }
  ],
  'dcm: removals alone never create the block': ['dcmDisplaySettings', undefined, { groups: { gw_a: null } }, undefined],
  'an entry or key named like a prototype property is an ordinary name': [
    'dcmDisplaySettings',
    { groups: {} },
    JSON.parse('{"groups":{"__proto__":"hidden","constructor":"hidden"}}'),
    JSON.parse('{"groups":{"__proto__":"hidden","constructor":"hidden"}}')
  ]
}

/** JSON.stringify drops `undefined` values, as the server's read does. */
function asStored(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe('applyAgentBlockUpdate: the copy after a save', () => {
  for (const [name, [field, stored, sent, expected]] of Object.entries(APPLY_CASES)) {
    it(name, () => {
      expect(asStored(applyAgentBlockUpdate(field, deepFreeze(structuredClone(stored)), deepFreeze(structuredClone(sent))))).toEqual(asStored(expected))
    })
  }

  it('never changes the copy or the save it was given, and shares the levels it did not change', () => {
    const stored = deepFreeze(structuredClone(DCM))
    const sent = deepFreeze({ groups: { gw_a: 'hidden' } })
    const next = applyAgentBlockUpdate('dcmDisplaySettings', stored, sent) as typeof DCM
    expect(stored).toEqual(DCM)
    expect(next.groups).toEqual({ gw_a: 'hidden', gw_b: 'hidden' })
    expect(next.tools).toBe(stored.tools)
  })

  it('a save that writes nothing answers the copy itself', () => {
    expect(applyAgentBlockUpdate('codex_settings', CODEX, {})).toBe(CODEX)
    expect(applyAgentBlockUpdate('codex_settings', CODEX, undefined)).toBe(CODEX)
  })

  it('reads a copy held in a proxy (the agents store keeps its agents in $state)', () => {
    const stored = new Proxy(structuredClone(CODEX), {})
    expect(applyAgentBlockUpdate('codex_settings', stored, { sandbox: 'read-only' })).toEqual({ ...CODEX, sandbox: 'read-only' })
  })

  it('refuses a block the server would refuse, before anything is laid over', () => {
    expect(() => applyAgentBlockUpdate('codex_settings', CODEX, 'gpt-6')).toThrow(AgentBlockShapeError)
    expect(() => applyAgentBlockUpdate('dcmDisplaySettings', DCM, { groups: ['a'] })).toThrow(AgentBlockShapeError)
  })
})

describe("applyAgentBlockUpdate and the server's write agree (the plan, run by the default lane's twin)", () => {
  function serverBlockAfter(field: AgentFieldByFieldBlock, stored: unknown, sent: unknown): unknown {
    const record: Record<string, unknown> = { id: 'agent_probe', user_id: 'user_probe', agentType: 'api' }
    if (stored !== undefined) record[field] = structuredClone(stored)
    const plan = planAgentRecordUpdate({ updates: { [field]: sent }, now: '2026-09-28T12:00:00.000Z' })
    const twin = runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plan, agentTypeSnapshotOf(record)))
    expect(twin.answer).toBe('OK')
    return twin.record[field]
  }

  for (const [name, [field, stored, sent]] of Object.entries(APPLY_CASES)) {
    it(name, () => {
      expect(asStored(applyAgentBlockUpdate(field, stored, sent))).toEqual(asStored(serverBlockAfter(field, stored, sent)))
    })
  }
})

describe('diffAgentBlock: only what differs', () => {
  it('nothing changed (order of keys ignored, undefined and null as absent) is undefined', () => {
    expect(diffAgentBlock('codex_settings', CODEX, { ...CODEX })).toBeUndefined()
    expect(diffAgentBlock('codex_settings', { a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined, e: null })).toBeUndefined()
    expect(diffAgentBlock('codex_settings', null, {})).toBeUndefined()
    expect(diffAgentBlock('codex_settings', undefined, { model: null })).toBeUndefined()
    expect(diffAgentBlock('claude_settings', { model: null }, {})).toBeUndefined()
  })

  it('names only the keys that differ; a removed key is null; a list is compared whole', () => {
    expect(diffAgentBlock('codex_settings', CODEX, { ...CODEX, model: 'gpt-6', sandbox: undefined, search: true, addDirs: ['/a', '/b', '/c'] })).toEqual({
      model: 'gpt-6',
      sandbox: null,
      search: true,
      addDirs: ['/a', '/b', '/c']
    })
    expect(diffAgentBlock('claude_settings', CLAUDE, { ...CLAUDE, addDirs: ['/a'] })).toBeUndefined()
    expect(diffAgentBlock('claude_settings', CLAUDE, { ...CLAUDE, addDirs: [] })).toEqual({ addDirs: [] })
  })

  it('a block with no copy: every key of the next block', () => {
    expect(diffAgentBlock('codex_settings', undefined, { model: 'gpt-6', sandbox: 'read-only' })).toEqual({ model: 'gpt-6', sandbox: 'read-only' })
    expect(diffAgentBlock('codex_settings', null, { model: 'gpt-6' })).toEqual({ model: 'gpt-6' })
  })

  it('the next block null clears a block that is an object (null), and changes nothing over one that is not', () => {
    expect(diffAgentBlock('codex_settings', CODEX, null)).toBeNull()
    expect(diffAgentBlock('codex_settings', {}, null)).toBeNull()
    expect(diffAgentBlock('codex_settings', null, null)).toBeUndefined()
    expect(diffAgentBlock('codex_settings', undefined, null)).toBeUndefined()
    expect(diffAgentBlock('codex_settings', CODEX, undefined)).toBeUndefined()
  })

  it('dcmDisplaySettings: the entries that differ under their map, a removed entry as null, a map that is the same not named', () => {
    const next = {
      ...DCM,
      groups: { gw_a: 'hidden', gw_c: 'group-only' },
      tools: { ...DCM.tools },
      toolDisplayPreferences: {}
    }
    expect(diffAgentBlock('dcmDisplaySettings', DCM, next)).toEqual({
      groups: { gw_a: 'hidden', gw_b: null, gw_c: 'group-only' },
      toolDisplayPreferences: { 'gw_a::read': null }
    })
  })

  it('dcmDisplaySettings: a map missing from the next block removes its entries one by one; a map missing from the copy adds them', () => {
    expect(diffAgentBlock('dcmDisplaySettings', DCM, { version: 1, groups: DCM.groups, tools: DCM.tools, groupDisplayPreferences: DCM.groupDisplayPreferences })).toEqual({
      toolDisplayPreferences: { 'gw_a::read': null }
    })
    expect(diffAgentBlock('dcmDisplaySettings', { version: 1 }, { version: 1, groups: { gw_a: 'hidden' }, tools: {} })).toEqual({ groups: { gw_a: 'hidden' } })
    expect(diffAgentBlock('dcmDisplaySettings', undefined, { version: 1, groups: {}, tools: {} })).toEqual({ version: 1 })
  })

  it('dcmDisplaySettings: ids with any characters are entry names', () => {
    const odd = 'gw"::to\\ol.[0]'
    expect(diffAgentBlock('dcmDisplaySettings', DCM, { ...DCM, tools: { ...DCM.tools, [odd]: 'hidden' } })).toEqual({ tools: { [odd]: 'hidden' } })
  })

  it('refuses a next block, or a dcmDisplaySettings map of it, that is neither an object nor null', () => {
    expect(() => diffAgentBlock('codex_settings', CODEX, 'oops')).toThrow(AgentBlockShapeError)
    expect(() => diffAgentBlock('dcmDisplaySettings', DCM, { ...DCM, groups: ['a'] })).toThrow(AgentBlockShapeError)
  })

  it('a key named like a prototype property is an ordinary name', () => {
    const next = JSON.parse('{"__proto__":"x","model":"gpt-5"}')
    const patch = diffAgentBlock('codex_settings', { model: 'gpt-5' }, next)
    expect(Object.keys(patch as object)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(patch)).toBe(Object.prototype)
  })
})

describe('diffAgentBlock and applyAgentBlockUpdate: the patch turns the copy into the next block', () => {
  const ROUND_TRIPS: Record<string, [AgentFieldByFieldBlock, unknown, unknown]> = {
    'codex: a model pick, a removed sandbox, a longer list': ['codex_settings', CODEX, { ...CODEX, model: 'gpt-6', sandbox: undefined, addDirs: ['/a', '/b', '/c'] }],
    'claude: mode and model': ['claude_settings', CLAUDE, { ...CLAUDE, permissionMode: 'plan', model: 'opus' }],
    'codex: from no block': ['codex_settings', undefined, CODEX],
    'codex: from a null block': ['codex_settings', null, CODEX],
    'codex: emptied key by key': ['codex_settings', CODEX, {}],
    'dcm: groups, tools and preferences change': [
      'dcmDisplaySettings',
      DCM,
      { version: 1, groups: { gw_a: 'hidden', gw_c: 'hidden' }, tools: {}, groupDisplayPreferences: { gw_a: 'group-only', gw_c: 'use-global' }, toolDisplayPreferences: { 'gw_a::read': 'name+hint' } }
    ],
    'dcm: from no block': ['dcmDisplaySettings', undefined, DCM],
    'dcm: nothing changed': ['dcmDisplaySettings', DCM, structuredClone(DCM)]
  }

  for (const [name, [field, baseline, next]] of Object.entries(ROUND_TRIPS)) {
    it(name, () => {
      const patch = diffAgentBlock(field, baseline, next)
      const after = applyAgentBlockUpdate(field, baseline, patch)
      const reads = (block: unknown) => (block == null ? {} : asStored(block))
      // The copy after the patch reads as the next block: a key that holds no value is absent.
      expect(pruned(reads(after))).toEqual(pruned(reads(next)))
      // And the server's write of that patch leaves the same block (no other lane to disagree).
      if (patch !== undefined) {
        const record: Record<string, unknown> = { id: 'agent_probe', user_id: 'user_probe', agentType: 'api' }
        if (baseline !== undefined) record[field] = structuredClone(baseline)
        const plan = planAgentRecordUpdate({ updates: { [field]: patch }, now: '2026-09-28T12:00:00.000Z' })
        const twin = runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plan, agentTypeSnapshotOf(record)))
        expect(pruned(reads(twin.record[field]))).toEqual(pruned(reads(next)))
      }
    })
  }

  /** A block with the keys that hold no value, and the empty maps, left out (a map that is empty reads as none). */
  function pruned(block: unknown): unknown {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block
    const entries = Object.entries(block as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, pruned(value)] as const)
      .filter(([, value]) => !(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0))
    return Object.fromEntries(entries)
  }
})

/**
 * BL-919: a control or form that sets a GROUP of keys as one choice (a Codex permission mode is a
 * mode, a sandbox and an approval; Claude's thinking is a switch and a budget) must send the whole
 * group when any key of it differs from the copy it started from. The copy may be older than the
 * record, and a key that equals it is then left out of the save while the record holds another
 * window's value of it: a MIX of two picks. Keys outside the groups still go by difference.
 */
describe('diffAgentBlockWithGroups: a group goes whole when any key of it differs (BL-919)', () => {
  const TRIO = { permissionMode: 'chat', sandbox: 'read-only', approval: 'never' }
  const CODEX_COPY = { model: 'gpt-6-astra', reasoningEffort: 'high', ...TRIO, addDirs: [] as string[] }

  it('names the groups once: the Codex permission trio and the Claude thinking pair', () => {
    expect([...CODEX_PERMISSION_GROUP]).toEqual(['permissionMode', 'sandbox', 'approval'])
    expect([...CLAUDE_THINKING_GROUP]).toEqual(['alwaysThinkingEnabled', 'maxThinkingTokens'])
    expect(AGENT_SETTINGS_KEY_GROUPS).toEqual({
      codex_settings: [CODEX_PERMISSION_GROUP],
      claude_settings: [CLAUDE_THINKING_GROUP],
      dcmDisplaySettings: []
    })
  })

  for (const [key, value] of [
    ['permissionMode', 'agent'],
    ['sandbox', 'workspace-write'],
    ['approval', 'on-request']
  ] as const) {
    it(`a changed ${key} brings the other two keys of the trio with it, with the values of the next block`, () => {
      const next = { ...CODEX_COPY, [key]: value }
      expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, next)).toEqual({
        permissionMode: next.permissionMode,
        sandbox: next.sandbox,
        approval: next.approval
      })
    })
  }

  it('a key outside the groups still goes alone, and does not bring the group', () => {
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, { ...CODEX_COPY, reasoningEffort: 'low' })).toEqual({
      reasoningEffort: 'low'
    })
    expect(diffAgentBlockWithGroups('claude_settings', CLAUDE, { ...CLAUDE, permissionMode: 'plan' })).toEqual({
      permissionMode: 'plan'
    })
  })

  it('a change in the group and a change outside it go together, each by its rule', () => {
    expect(
      diffAgentBlockWithGroups('codex_settings', CODEX_COPY, { ...CODEX_COPY, approval: 'on-request', model: 'gpt-6-sol' })
    ).toEqual({ model: 'gpt-6-sol', permissionMode: 'chat', sandbox: 'read-only', approval: 'on-request' })
  })

  it('nothing changed is undefined, as diffAgentBlock says: an unchanged group is not sent', () => {
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, { ...CODEX_COPY })).toBeUndefined()
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, undefined)).toBeUndefined()
    expect(diffAgentBlockWithGroups('codex_settings', null, null)).toBeUndefined()
  })

  it('the next block null clears a block that is an object (null), exactly as diffAgentBlock does', () => {
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, null)).toBeNull()
  })

  it('a group key the next block leaves out is sent as null, a removal (Claude: the budget with the switch)', () => {
    const on = { ...CLAUDE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 }
    // Thinking turned Off: the form drops the budget; both keys go, the budget as null.
    expect(diffAgentBlockWithGroups('claude_settings', on, { ...CLAUDE, alwaysThinkingEnabled: false })).toEqual({
      alwaysThinkingEnabled: false,
      maxThinkingTokens: null
    })
    // A budget edit alone brings the switch: the copy that saw thinking On never leaves Off with a budget.
    expect(diffAgentBlockWithGroups('claude_settings', on, { ...on, maxThinkingTokens: 5000 })).toEqual({
      alwaysThinkingEnabled: true,
      maxThinkingTokens: 5000
    })
    // The switch alone (no budget on either side) brings a removal of the budget.
    expect(
      diffAgentBlockWithGroups('claude_settings', CLAUDE, { ...CLAUDE, alwaysThinkingEnabled: true })
    ).toEqual({ alwaysThinkingEnabled: true, maxThinkingTokens: null })
  })

  it('a block with no copy: the whole next block, and the group keys it lacks as null (another window may hold them)', () => {
    expect(diffAgentBlockWithGroups('claude_settings', null, { model: 'sonnet', alwaysThinkingEnabled: false })).toEqual({
      model: 'sonnet',
      alwaysThinkingEnabled: false,
      maxThinkingTokens: null
    })
    expect(diffAgentBlockWithGroups('codex_settings', undefined, { ...CODEX_COPY })).toEqual(CODEX_COPY)
  })

  it('takes the groups as an argument; dcmDisplaySettings has none', () => {
    const next = { ...CODEX_COPY, model: 'gpt-6-sol' }
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, next, [['model', 'reasoningEffort']])).toEqual({
      model: 'gpt-6-sol',
      reasoningEffort: 'high'
    })
    expect(diffAgentBlockWithGroups('codex_settings', CODEX_COPY, next, [])).toEqual({ model: 'gpt-6-sol' })
    expect(diffAgentBlockWithGroups('dcmDisplaySettings', DCM, { ...DCM, groups: { gw_a: 'hidden' } })).toEqual(
      diffAgentBlock('dcmDisplaySettings', DCM, { ...DCM, groups: { gw_a: 'hidden' } })
    )
  })

  it('a group key named like a prototype property is an ordinary name', () => {
    const copy = JSON.parse('{"__proto__":"x","model":"gpt-5","a":1}')
    const next = JSON.parse('{"__proto__":"x","model":"gpt-5","a":2}')
    // `a` differs; `__proto__` equals the copy and comes in with it as the group's own key.
    const patch = diffAgentBlockWithGroups('codex_settings', copy, next, [['a', '__proto__']])
    expect(Object.keys(patch as object).sort()).toEqual(['__proto__', 'a'])
    expect(Object.getPrototypeOf(patch)).toBe(Object.prototype)
  })

  it("the server's write of an older copy's pick leaves ONE mode when another window picked another mode meanwhile", () => {
    // The copy: Chat. Another window (the chat bar) wrote Agent since. The older Settings picks Agent (full).
    const stored = { ...CODEX_COPY, permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    const next = { ...CODEX_COPY, permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never' }
    const patch = diffAgentBlockWithGroups('codex_settings', CODEX_COPY, next)
    const record = { id: 'agent_probe', user_id: 'user_probe', agentType: 'api', codex_settings: structuredClone(stored) }
    const plan = planAgentRecordUpdate({ updates: { codex_settings: patch }, now: '2026-09-28T12:00:00.000Z' })
    const twin = runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plan, agentTypeSnapshotOf(record)))
    const written = twin.record.codex_settings as Record<string, unknown>
    expect({ permissionMode: written.permissionMode, sandbox: written.sandbox, approval: written.approval }).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    // The plain difference leaves the mix behind (the bug this rule closes).
    const plain = planAgentRecordUpdate({
      updates: { codex_settings: diffAgentBlock('codex_settings', CODEX_COPY, next) },
      now: '2026-09-28T12:00:00.000Z'
    })
    const mixed = runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plain, agentTypeSnapshotOf(record))).record
      .codex_settings as Record<string, unknown>
    expect(mixed.approval).toBe('on-request')
  })
})

describe('sameJsonValue', () => {
  it('compares deeply, ignores key order, and counts undefined as absent', () => {
    expect(sameJsonValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true)
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false)
    expect(sameJsonValue({ a: null }, { a: undefined })).toBe(false)
  })
})
