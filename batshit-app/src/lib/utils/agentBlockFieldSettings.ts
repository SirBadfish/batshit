import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { CodexAgentSettings } from '$lib/types/codex'
import type {
  AgentDcmDisplaySettings,
  AgentDcmGroupDisplayMode,
  AgentDcmGroupDisplayPreference,
  AgentDcmToolDisplayPreference,
  DcmToolDisplayMode
} from '$lib/types/database'

/**
 * BL-848, BL-855: three agent blocks are written FIELD BY FIELD, so a save that changes one key
 * never carries an older copy of the others.
 *
 * - `codex_settings` and `claude_settings` (the Codex and Claude model, mode, reasoning, sandbox,
 *   directories, config overrides): each key a save names is written at `$.<field>["<key>"]`;
 * - `dcmDisplaySettings` (the Tool Grid display modes): `version` at its own key, and each ENTRY
 *   of the four maps (`groups`, `tools`, `groupDisplayPreferences`, `toolDisplayPreferences`, each
 *   keyed by a gateway or tool id) at `$.dcmDisplaySettings["<map>"]["<id>"]`.
 *
 * Before, `updateAgent` wrote such a block whole at `$.<field>`, so a chat-bar control or a
 * Settings window holding an older copy took back a model, reasoning setting, sandbox, gateway or
 * tool choice made somewhere else, with no word (BL-833 and BL-841 did the same for
 * `provider_specific_settings` and its `nativeTools`).
 *
 * This file is the one place that knows the rules. `planAgentBlockWrite` is the write a save makes
 * (`planAgentRecordUpdate` turns its steps into by-path ops), `applyAgentBlockUpdate` lays a save
 * over a copy kept in the browser by the very same steps, and `diffAgentBlock` is what a control
 * or form sends: only the keys (or map entries) that differ from the copy it started from.
 *
 * The rules of a save's block:
 * - a key sent with a value is written whole at its key (arrays such as `addDirs` and
 *   `configOverrides`, and nested objects, are one value); a key sent as `null` is removed; a key
 *   sent as `undefined` (JSON drops it) or not sent stays as stored;
 * - the block is made an object first only when some key is set; a save of removals alone never
 *   creates it, and `{}` writes nothing;
 * - for `dcmDisplaySettings` a map sent as an object is written entry by entry the same way (the
 *   map is made an object first only when one of its entries is set); a map sent as `null` is
 *   removed;
 * - the block sent as `null` is a whole write of `null`: the Codex and Claude readers then use the
 *   older `codex_*` and `claude_*` keys of `provider_specific_settings`, and the Tool Grid readers
 *   the older `dcm_display_settings` name (which can bring older settings back); a block that is
 *   neither an object nor null is refused.
 * Every OTHER agent field keeps its whole write: a list such as `defaultMCPGateways` is one value,
 * and a save names only the lists it changed.
 *
 * A few keys are ONE choice, not separate settings (BL-919): the Codex mode, its sandbox and its
 * approval; Claude's thinking switch and its budget. `CODEX_PERMISSION_GROUP` and
 * `CLAUDE_THINKING_GROUP` name them once, for the chat bar (`chatBarBlockSave`'s `group`) and for
 * Agent Settings (`diffAgentBlockWithGroups`): a control or form that sets one of these keys sends
 * the whole group, so a copy older than the record can never leave the record holding a MIX of its
 * pick and another window's (a sandbox or approval left over from another mode).
 */

export const AGENT_FIELD_BY_FIELD_BLOCKS = ['codex_settings', 'claude_settings', 'dcmDisplaySettings'] as const

/**
 * BL-919: the keys of one Codex permission choice. The run reads the saved mode and sandbox
 * (`codexBridge.ts`); its approval is derived from the mode and the agent's Tool Approval, and the
 * saved `approval` reaches only the managed `config.toml` (`codexProfileManager.ts`), which the run
 * settings override. The three still go together: the record must never hold a mix the picker did
 * not show (one window's `permissionMode` with another's `sandbox`, or a config file that says
 * another mode's approval).
 */
export const CODEX_PERMISSION_GROUP = ['permissionMode', 'sandbox', 'approval'] as const satisfies readonly (keyof CodexAgentSettings)[]

/** BL-919: Claude's thinking switch and its budget (the budget only means something while the switch is on). */
export const CLAUDE_THINKING_GROUP = ['alwaysThinkingEnabled', 'maxThinkingTokens'] as const satisfies readonly (keyof ClaudeAgentSettings)[]

/**
 * BL-919: the groups Agent Settings sends whole, per block: a change to any key of a group sends all
 * of its keys (`diffAgentBlockWithGroups`). The Tool Grid display settings have none.
 */
export const AGENT_SETTINGS_KEY_GROUPS = {
  codex_settings: [CODEX_PERMISSION_GROUP],
  claude_settings: [CLAUDE_THINKING_GROUP],
  dcmDisplaySettings: []
} as const satisfies { [Field in AgentFieldByFieldBlock]: readonly (readonly string[])[] }

export type AgentFieldByFieldBlock = (typeof AGENT_FIELD_BY_FIELD_BLOCKS)[number]

/** The maps of `dcmDisplaySettings` (`AgentDcmDisplaySettings`), each keyed by a gateway or tool id. */
export const DCM_DISPLAY_MAP_KEYS = ['groups', 'tools', 'groupDisplayPreferences', 'toolDisplayPreferences'] as const

export type AgentBlock = Record<string, unknown>

/** A save's block: the keys it names, a key sent as `null` removed; a key it leaves out stays as stored. */
export type AgentBlockSave<T> = { [Key in keyof T]?: T[Key] | null }

/** A save's `dcmDisplaySettings`: `version` and, per map, the entries it names (an entry sent as `null` is removed). */
export interface AgentDcmDisplaySettingsSave {
  version?: AgentDcmDisplaySettings['version'] | null
  groups?: Record<string, AgentDcmGroupDisplayMode | null> | null
  tools?: Record<string, DcmToolDisplayMode | null> | null
  groupDisplayPreferences?: Record<string, AgentDcmGroupDisplayPreference | null> | null
  toolDisplayPreferences?: Record<string, AgentDcmToolDisplayPreference | null> | null
}

/** What a save of each block sends (`diffAgentBlock` builds it; the agent PUT writes it field by field). */
export interface AgentBlockSaveByField {
  codex_settings: AgentBlockSave<CodexAgentSettings>
  claude_settings: AgentBlockSave<ClaudeAgentSettings>
  dcmDisplaySettings: AgentDcmDisplaySettingsSave
}

/**
 * One by-path change of a block. `path` is `[]` (the block), `[key]`, or `[map, id]` (an entry of
 * a `dcmDisplaySettings` map): `ensure` makes that path an object when it is not one, `set` writes a
 * value there, `delete` removes it (nothing happens when its parent is not an object).
 */
export type AgentBlockStep =
  | { step: 'ensure'; path: readonly string[] }
  | { step: 'set'; path: readonly string[]; value: unknown }
  | { step: 'delete'; path: readonly string[] }

/** What a save of a block writes: the block as `null`, or these steps in order (none: nothing). */
export type AgentBlockWrite = { kind: 'whole'; value: null } | { kind: 'steps'; steps: AgentBlockStep[] }

/** A block (or a map of one) that is neither an object nor null; the message says what to change. */
export class AgentBlockShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentBlockShapeError'
  }
}

const BLOCK_LABELS: Record<AgentFieldByFieldBlock, string> = {
  codex_settings: 'the Codex settings',
  claude_settings: 'the Claude settings',
  dcmDisplaySettings: 'the Tool Grid display settings'
}

export function isAgentFieldByFieldBlock(field: string): field is AgentFieldByFieldBlock {
  return (AGENT_FIELD_BY_FIELD_BLOCKS as readonly string[]).includes(field)
}

function isDcmMapKey(key: string): boolean {
  return (DCM_DISPLAY_MAP_KEYS as readonly string[]).includes(key)
}

function isPlainObject(value: unknown): value is AgentBlock {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(target: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, name)
}

/** An own key's value; a name the object does not hold itself reads as nothing (`__proto__` included). */
function readOwn(target: AgentBlock, name: string): unknown {
  return hasOwn(target, name) ? target[name] : undefined
}

/** Sets an own key, a `__proto__` key included (a plain assignment of that name sets the prototype). */
function setOwn(target: AgentBlock, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true })
}

function copyWith(target: AgentBlock, name: string, value: unknown): AgentBlock {
  const copy: AgentBlock = { ...target }
  setOwn(copy, name, value)
  return copy
}

function copyWithout(target: AgentBlock, name: string): AgentBlock {
  const copy: AgentBlock = { ...target }
  delete copy[name]
  return copy
}

/**
 * Deep equality over JSON values. Object key order does not matter, and a key holding
 * `undefined` counts as absent (JSON drops it).
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((entry, index) => sameJsonValue(entry, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => key in right && sameJsonValue(left[key], right[key]))
  }
  return false
}

function shapeError(field: AgentFieldByFieldBlock, entry?: string): AgentBlockShapeError {
  const subject =
    entry === undefined
      ? `The setting ${JSON.stringify(field)} (${BLOCK_LABELS[field]})`
      : `The setting ${JSON.stringify(field)} entry ${JSON.stringify(entry)} (${BLOCK_LABELS[field]})`
  return new AgentBlockShapeError(`${subject} must be an object or null, so nothing was saved.`)
}

/**
 * The steps a save's block writes (the rules above), in the order they run: the block made an
 * object first when a key is set, then each key in the order the save names them; a
 * `dcmDisplaySettings` map is made an object right before its own entries. `undefined` (no block
 * sent) writes nothing. Throws `AgentBlockShapeError` for a block, or a `dcmDisplaySettings` map,
 * that is neither an object nor null, before any step is produced.
 */
export function planAgentBlockWrite(field: AgentFieldByFieldBlock, sent: unknown): AgentBlockWrite {
  if (sent === undefined) return { kind: 'steps', steps: [] }
  if (sent === null) return { kind: 'whole', value: null }
  if (!isPlainObject(sent)) throw shapeError(field)

  const body: AgentBlockStep[] = []
  for (const [key, value] of Object.entries(sent)) {
    if (value === undefined) continue
    if (value === null) {
      body.push({ step: 'delete', path: [key] })
      continue
    }
    if (field === 'dcmDisplaySettings' && isDcmMapKey(key)) {
      if (!isPlainObject(value)) throw shapeError(field, key)
      const entrySteps: AgentBlockStep[] = []
      for (const [id, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        entrySteps.push(entry === null ? { step: 'delete', path: [key, id] } : { step: 'set', path: [key, id], value: entry })
      }
      if (entrySteps.some((entryStep) => entryStep.step === 'set')) body.push({ step: 'ensure', path: [key] })
      body.push(...entrySteps)
      continue
    }
    body.push({ step: 'set', path: [key], value })
  }
  const setsSomething = body.some((step) => step.step === 'set')
  return { kind: 'steps', steps: setsSomething ? [{ step: 'ensure', path: [] }, ...body] : body }
}

/** One step laid over a copy, the way the by-path write acts on the stored block. */
function applyStep(block: unknown, step: AgentBlockStep): unknown {
  const [key, id] = step.path
  if (step.step === 'ensure') {
    if (key === undefined) return isPlainObject(block) ? block : {}
    if (!isPlainObject(block)) return block
    return isPlainObject(readOwn(block, key)) ? block : copyWith(block, key, {})
  }
  // A path under a parent that is not an object reads as nothing: a write or a removal there
  // changes nothing (RedisJSON, and the default lane's twin).
  if (!isPlainObject(block)) return block
  if (id === undefined) {
    if (step.step === 'set') return copyWith(block, key, step.value)
    return hasOwn(block, key) ? copyWithout(block, key) : block
  }
  const map = readOwn(block, key)
  if (!isPlainObject(map)) return block
  if (step.step === 'set') return copyWith(block, key, copyWith(map, id, step.value))
  return hasOwn(map, id) ? copyWith(block, key, copyWithout(map, id)) : block
}

/**
 * The block as the server stores it after `sent` is written (for a copy kept in the browser): the
 * very steps `planAgentBlockWrite` gives the server's by-path write. The copy is never mutated;
 * only the levels a step changes are copied. A save that writes nothing answers `stored` itself.
 * Throws `AgentBlockShapeError` for a block the server would refuse.
 */
export function applyAgentBlockUpdate(
  field: AgentFieldByFieldBlock,
  stored: unknown,
  sent: unknown
): AgentBlock | null | undefined {
  const write = planAgentBlockWrite(field, sent)
  if (write.kind === 'whole') return null
  return write.steps.reduce(applyStep, stored) as AgentBlock | null | undefined
}

/** The entries of one `dcmDisplaySettings` map that differ, a removed one as `null`; `undefined` when none. */
function diffDcmMap(field: AgentFieldByFieldBlock, key: string, before: unknown, after: unknown): AgentBlock | undefined {
  if (after !== null && !isPlainObject(after)) throw shapeError(field, key)
  const beforeEntries = isPlainObject(before) ? before : {}
  const afterEntries = isPlainObject(after) ? after : {}
  const changes: AgentBlock = {}
  for (const id of new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])) {
    const beforeEntry = readOwn(beforeEntries, id) ?? null
    const afterEntry = readOwn(afterEntries, id) ?? null
    if (!sameJsonValue(beforeEntry, afterEntry)) setOwn(changes, id, afterEntry)
  }
  return Object.keys(changes).length > 0 ? changes : undefined
}

/**
 * What a control or form sends to turn `baseline` (the copy it started from) into `next`: only the
 * keys that differ, a removed key as `null`; for `dcmDisplaySettings` the maps' entries that
 * differ under their map (a map that is the same is not named), a removed entry as `null`.
 * Deep equality per key, object key order ignored; a `null` or `undefined` value counts as absent
 * on both sides. `undefined` when nothing changed, or when `next` is not given. `next` as `null`
 * over a block that is an object is `null`: the whole block is cleared (it then reads as absent,
 * the way it did before it was ever set); over a block that is not, nothing changed. A `next`
 * (or a `dcmDisplaySettings` map of it) that is neither an object nor null throws
 * `AgentBlockShapeError`, as the server would refuse it.
 *
 * `applyAgentBlockUpdate(field, baseline, diffAgentBlock(field, baseline, next))` reads as `next`.
 */
export function diffAgentBlock<Field extends AgentFieldByFieldBlock>(
  field: Field,
  baseline: unknown,
  next: unknown
): AgentBlockSaveByField[Field] | null | undefined {
  return diffBlock(field, baseline, next) as AgentBlockSaveByField[Field] | null | undefined
}

function diffBlock(field: AgentFieldByFieldBlock, baseline: unknown, next: unknown): AgentBlock | null | undefined {
  if (next === undefined) return undefined
  if (next === null) return isPlainObject(baseline) ? null : undefined
  if (!isPlainObject(next)) throw shapeError(field)

  const before = isPlainObject(baseline) ? baseline : {}
  const changes: AgentBlock = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const beforeValue = readOwn(before, key) ?? null
    const afterValue = readOwn(next, key) ?? null
    if (field === 'dcmDisplaySettings' && isDcmMapKey(key)) {
      const entries = diffDcmMap(field, key, beforeValue, afterValue)
      if (entries) setOwn(changes, key, entries)
      continue
    }
    if (!sameJsonValue(beforeValue, afterValue)) setOwn(changes, key, afterValue)
  }
  return Object.keys(changes).length > 0 ? changes : undefined
}

/**
 * BL-919: `diffAgentBlock` for a form that sets GROUPS of keys as one choice (Agent Settings' Codex
 * and Claude sections). A group is sent WHOLE whenever ANY of its keys differs from `baseline`, with
 * the values of `next` (a key `next` leaves out goes as `null`, a removal), even the keys that equal
 * the baseline. The baseline is the copy the form loaded or last saved, and the record may be newer
 * (the chat bar, a second window): a key left out because it equals that older copy would keep the
 * record's other value, and the record would end up holding a MIX of this pick and the other window's
 * (BL-919: Agent with another mode's sandbox). Every key outside the groups still goes by difference.
 * `groups` is `AGENT_SETTINGS_KEY_GROUPS[field]` unless given.
 *
 * As `diffAgentBlock` otherwise: `undefined` when nothing changed (an unchanged group is not sent);
 * `null` for a `next` of `null` over a block that is an object; a block with no copy goes out whole
 * (its group keys `next` lacks as `null`, since another window may have created the block since).
 * The chat bar's own rule for its controls (always send the group they set) is `chatBarBlockSave`.
 */
export function diffAgentBlockWithGroups<Field extends AgentFieldByFieldBlock>(
  field: Field,
  baseline: unknown,
  next: unknown,
  groups: readonly (readonly string[])[] = AGENT_SETTINGS_KEY_GROUPS[field]
): AgentBlockSaveByField[Field] | null | undefined {
  const change = diffBlock(field, baseline, next)
  if (change === undefined || change === null) return change as null | undefined
  const nextBlock = next as AgentBlock
  let merged = change
  for (const group of groups) {
    if (!group.some((key) => hasOwn(change, key))) continue
    if (merged === change) merged = { ...change }
    for (const key of group) {
      if (!hasOwn(merged, key)) setOwn(merged, key, readOwn(nextBlock, key) ?? null)
    }
  }
  return merged as AgentBlockSaveByField[Field]
}
