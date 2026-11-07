import {
  AGENT_FIELD_NAME,
  AgentUpdateRejectedError,
  planRecordFieldOps,
  type AgentRecordOp
} from '$lib/server/agentRecordUpdate'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import type { SubagentType } from '$lib/utils/subagentType'
import { normalizeSubagentTimeoutSeconds } from '$lib/utils/subagentTimeout'
import { normalizeSubagentMaxToolSteps } from '$lib/utils/subagentToolSteps'

/**
 * BL-914: a Subagent record update is a list of by-path writes, run in one step inside Redis
 * (`UPDATE_SUBAGENT_FIELDS_SCRIPT` in `redis.ts`; the default lane's twin runs the same
 * arguments, `test-utils/agentUpdateScriptTwin.ts`). `PUT /api/subagents/[id]` used to read the
 * record, wait for the request body, lay the body over the record it had read
 * (`{ ...existing, ...body }`) and write the WHOLE record back, so a partial `claude_settings`,
 * `provider_specific_settings` or `dcmDisplaySettings` erased the keys it did
 * not name, and two saves of different fields that overlapped in time (the core autosave and the
 * Tool Grid save of one panel) took back each other's field, both answering success.
 *
 * The rules are the agent update's (`agentRecordUpdate.ts`, BL-768, and `planRecordFieldOps`, the
 * one place that knows them), for every field a save names:
 * - each named field is written at `$.<field>` whole; `undefined` is skipped;
 * - `provider_specific_settings` key by key (`nativeTools` field by field), `claude_settings`
 *   and `dcmDisplaySettings` key by key (each map entry on its own): a key or
 *   entry passed as `null` is removed, one not passed stays, the block passed as `null` removes
 *   `provider_specific_settings` and is a write of `null` for the other three; a block that is
 *   neither an object nor null is refused (400) before the script;
 * - every other field stores a `null` it is passed, except the fields of `SUBAGENT_REMOVES_ON_NULL`,
 *   which a `null` removes;
 * - `updated_at` is stamped by the plan, last; `id`, `user_id`, `slug` and `created_at` are never
 *   written (`SUBAGENT_KEPT_FIELDS`).
 *
 * The type fields (`subagentType`, and the webhook pair and `workflowName` of the removed n8n
 * Workflow Subagent) are DERIVED: they are written only when the request names one of them
 * (`deriveSubagentTypeWrites`), never on every save, or a save of another field would put a stale
 * type over another save's type change.
 * Names, broken characters and depth (64) are checked before the script, because a Lua script does
 * not roll back.
 */

/** Fields the record keeps as they are: a save never writes them (the stamp is the plan's own). */
export const SUBAGENT_KEPT_FIELDS: ReadonlySet<string> = new Set(['id', 'user_id', 'slug', 'created_at', 'updated_at'])

/** Fields a save reaches only through the type rule (`deriveSubagentTypeWrites`), never as the body names them. */
export const SUBAGENT_TYPE_FIELDS: ReadonlySet<string> = new Set([
  'subagentType',
  'subagent_type',
  'webhook_url',
  'webhookUrl',
  'workflowName'
])

/**
 * Fields a `null` removes: an emptied Custom System Prompt is no prompt (BL-482), a blank or null
 * Call Timeout or Max Tool Steps is no limit, and the type rule removes the webhook pair, the
 * workflow name and the legacy `subagent_type` this way. Every other field stores the null a save
 * passes.
 */
export const SUBAGENT_REMOVES_ON_NULL: ReadonlySet<string> = new Set([
  'system_prompt',
  'timeout_seconds',
  'max_tool_steps',
  'webhook_url',
  'webhookUrl',
  'workflowName',
  'subagent_type'
])

function hasOwn(target: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, name)
}

/** Sets an own key, a `__proto__` key included (a plain assignment of that name sets the prototype). */
function setOwn(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * The type fields a save writes, as `null` for a removal. Nothing when the request names none of
 * `subagentType`, `webhook_url`/`webhookUrl` or `workflowName`. Otherwise `subagentType` is written
 * (as `nextType`, the named type else the stored one), and the legacy `subagent_type` removed,
 * only when the request names `subagentType`; the webhook pair and the workflow name are always
 * removed, because no live type keeps them since the n8n Workflow Subagent was removed (SA-139 R2).
 * A save of other fields never writes them, so it cannot put a stale type over another save's
 * type change.
 */
export function deriveSubagentTypeWrites(input: {
  body: Record<string, unknown>
  nextType: SubagentType
}): Record<string, unknown> {
  const { body, nextType } = input
  const namesType = hasOwn(body, 'subagentType')
  const namesWebhook = hasOwn(body, 'webhook_url') || hasOwn(body, 'webhookUrl')
  const namesWorkflowName = hasOwn(body, 'workflowName')
  if (!namesType && !namesWebhook && !namesWorkflowName) return {}

  const writes: Record<string, unknown> = {}
  if (namesType) {
    writes.subagentType = nextType
    writes.subagent_type = null
  }
  writes.webhook_url = null
  writes.webhookUrl = null
  writes.workflowName = null
  return writes
}

/**
 * What a `PUT /api/subagents/[id]` body writes: the fields it names as they are, except the ones
 * the record keeps (`SUBAGENT_KEPT_FIELDS`) and the type fields (`deriveSubagentTypeWrites` owns
 * them); an emptied Custom System Prompt (`''`, spaces or `null`) and a blank or null Call Timeout
 * as a removal (`null`); the timeout and the avatar icon and fit normalized (the route refused a
 * bad one before this, an icon or fit it cannot make throws a 400 here). `undefined` values name
 * nothing.
 */
export function buildSubagentWrites(input: {
  body: Record<string, unknown>
  nextType: SubagentType
}): Record<string, unknown> {
  const { body } = input
  if (Object.hasOwn(body, 'app_action_policy')) throw new AgentUpdateRejectedError('Subagents cannot hold or change a Primary Agent App Actions policy.')
  const writes: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(body)) {
    if (SUBAGENT_KEPT_FIELDS.has(field) || SUBAGENT_TYPE_FIELDS.has(field)) continue
    setOwn(writes, field, value)
  }
  if (hasOwn(body, 'system_prompt')) {
    const prompt = body.system_prompt
    if (prompt === null || (typeof prompt === 'string' && prompt.trim() === '')) writes.system_prompt = null
  }
  if (hasOwn(body, 'timeout_seconds')) {
    writes.timeout_seconds = normalizeSubagentTimeoutSeconds(body.timeout_seconds) ?? null
  }
  if (hasOwn(body, 'max_tool_steps')) {
    writes.max_tool_steps = normalizeSubagentMaxToolSteps(body.max_tool_steps) ?? null
  }
  if (hasOwn(body, 'avatar_icon_ref')) {
    writes.avatar_icon_ref = normalizeOptionalIconRefInput(body.avatar_icon_ref, 'avatar_icon_ref')
  }
  if (hasOwn(body, 'avatar_icon_fit')) {
    writes.avatar_icon_fit = normalizeOptionalAvatarIconFitInput(body.avatar_icon_fit, 'avatar_icon_fit')
  }
  for (const [field, value] of Object.entries(deriveSubagentTypeWrites(input))) setOwn(writes, field, value)
  return writes
}

/**
 * The by-path writes of a Subagent update (`writes` is what `buildSubagentWrites` gives) and the
 * stamp, `now`, last. Throws `AgentUpdateRejectedError`, before anything is written, for a field
 * name that is not a field name, a `provider_specific_settings`, `claude_settings` or
 * `dcmDisplaySettings` (or a `dcmDisplaySettings` map) that is neither an
 * object nor null, a key or value with a broken character (a lone half of a surrogate pair), or a
 * value nested deeper than `MAX_AGENT_VALUE_DEPTH`.
 */
export function planSubagentRecordUpdate({
  writes,
  now
}: {
  writes: Record<string, unknown>
  now: string
}): { ops: AgentRecordOp[] } {
  if (Object.hasOwn(writes, 'app_action_policy')) throw new AgentUpdateRejectedError('Subagents cannot hold or change a Primary Agent App Actions policy.')
  const ops: AgentRecordOp[] = []
  for (const [field, value] of Object.entries(writes)) {
    if (!AGENT_FIELD_NAME.test(field)) throw new AgentUpdateRejectedError(`Not a Subagent field name: ${field}`)
    if (value === undefined || SUBAGENT_KEPT_FIELDS.has(field)) continue
    ops.push(...planRecordFieldOps(field, value, SUBAGENT_REMOVES_ON_NULL))
  }
  ops.push({ op: 'set', field: 'updated_at', value: now })
  return { ops }
}
