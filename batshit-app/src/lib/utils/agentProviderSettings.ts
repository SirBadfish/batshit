import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'

/**
 * BL-514: an agent's `provider_specific_settings` holds two kinds of keys. MODEL keys are a copy
 * of the picked preset's values (a temperature, a reasoning setting, a Custom Parameter); the
 * AGENT's OWN keys are `isAgentRuntimeSettingKey` (`nativeTools` with the Work mode, the Bash
 * never-allow list, the execution backend and the web search provider; `codex_*`, `claude_*`,
 * `batshit_*`, and the legacy native-tool keys). One rule, the same one that keeps those keys out
 * of a provider's request and keeps them when a send builds its settings from a preset (BL-515).
 *
 * A save that sends a block (the chat-bar model picker, Agent Settings) used to replace the whole
 * block, so picking a model threw the agent's `nativeTools` away and a Plan-mode agent quietly got
 * write access back. The merge below is the server's rule for every save (`PUT /api/agents/[id]`),
 * and the agents store and Agent Settings lay a save over their own copies the same way.
 *
 * BL-833: a block that names only own keys leaves the model keys alone, so a control that changes
 * one own key (the chat bar's Codex and Claude mode, Work mode and reasoning controls) sends that
 * key only. BL-841: `nativeTools` is written field by field (`updateAgent` writes each named field
 * at `$.provider_specific_settings["nativeTools"]["<field>"]`), so a save of one of its fields
 * never carries an older copy of the others.
 */

type Block = Record<string, unknown>

/**
 * The own key whose value is a block of its own, written field by field (BL-841): the Work mode,
 * the Bash never-allow and allow lists, the command location, the web search choice, ... A save
 * names only the fields it changes (a field named `null` is removed; `nativeTools: null` removes
 * the whole block).
 */
export const NATIVE_TOOLS_SETTING_KEY = 'nativeTools'

function asBlock(value: unknown): Block | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Block) : null
}

/** A preset's settings without the agent's own keys: what a model pick may send. */
export function presetModelSettings(settings: unknown): Block {
  return Object.fromEntries(
    Object.entries(asBlock(settings) ?? {}).filter(([key]) => !isAgentRuntimeSettingKey(key))
  )
}

/**
 * BL-833: a block that names at least one key, every one of them an agent's own key: the save of
 * a control that changes only own keys, which leaves the stored model keys alone. A key whose
 * value is `undefined` names nothing (JSON drops it).
 */
export function namesOnlyOwnKeys(block: Block): boolean {
  const named = Object.keys(block).filter((key) => block[key] !== undefined)
  return named.length > 0 && named.every(isAgentRuntimeSettingKey)
}

/**
 * The key-by-key write (`updateAgent`: a `null` key is removed) a save's block makes:
 * - a block that names only own keys (BL-833) leaves the stored model keys as they are;
 * - any other block (one that names a model key, even as `null`, or an empty one: a preset with
 *   no settings) replaces the stored model keys with the ones it names: a stored model key it
 *   leaves out is removed;
 * - a block sent as `null` removes the stored model keys;
 * - an AGENT key is written only when the body names it (`null` removes it); one the body leaves
 *   out is kept. `nativeTools` goes on as the body sent it: `updateAgent` writes it field by field
 *   (BL-841).
 * `undefined` when the body sends no block (nothing to write).
 */
export function buildAgentProviderSettingsPatch(stored: unknown, sent: unknown): Block | undefined {
  if (sent === undefined) return undefined
  const storedBlock = asBlock(stored) ?? {}
  const sentBlock = sent === null ? {} : asBlock(sent)
  if (!sentBlock) throw new Error('provider_specific_settings must be an object or null')
  const removals = namesOnlyOwnKeys(sentBlock)
    ? []
    : Object.keys(storedBlock).filter((key) => !isAgentRuntimeSettingKey(key) && !(key in sentBlock))
  return {
    ...Object.fromEntries(removals.map((key) => [key, null])),
    ...sentBlock
  }
}

/** `nativeTools` after a save named some of its fields (`null` removes a field). */
function applyNativeToolsFields(stored: unknown, fields: Block): Block {
  const next: Block = { ...(asBlock(stored) ?? {}) }
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value === null) delete next[field]
    else next[field] = value
  }
  return next
}

/** The block that `buildAgentProviderSettingsPatch`'s write leaves (for a copy kept in the browser). */
export function applyAgentProviderSettingsUpdate(stored: unknown, sent: unknown): Block | undefined {
  const patch = buildAgentProviderSettingsPatch(stored, sent)
  if (patch === undefined) return asBlock(stored) ?? undefined
  const next: Block = { ...(asBlock(stored) ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else if (key === NATIVE_TOOLS_SETTING_KEY && asBlock(value)) next[key] = applyNativeToolsFields(next[key], value as Block)
    else next[key] = value
  }
  return next
}

/** The `nativeTools` block of a settings copy, or `{}` when it has none (or one that is not an object). */
export function nativeToolsOf(settings: unknown): Block {
  return asBlock(asBlock(settings)?.nativeTools) ?? {}
}

/**
 * BL-833: what the chat bar's Work mode control (`ChatInput.handleNativeBashModeSelect`) sends:
 * only the `nativeTools` fields its pick sets, never the rest of its copy of the block (the copy
 * can be older than the record: Agent Settings in another window may have changed the never-allow
 * list or the web search choice since).
 * - `bashAccessMode`: the mode the user chose, always (the copy may show it already while the
 *   record holds another);
 * - `executionBackend`: ALWAYS, because the mode and its command location are one choice (review
 *   fix): Full access runs on the Mac itself (`local`); every other mode takes a sandbox the copy
 *   already names, or the default one. Sent only when it differed from the copy, a Plan pick from
 *   a copy older than another window's Full access left the record on `local`: commands ran on
 *   the Mac while the chat bar showed the sandbox. At worst this swaps one sandbox for another;
 * - `bashPolicyMode`: the legacy name of the mode, removed (`null`) when the copy still has it
 *   (every reader takes `bashAccessMode` first).
 */
export function chatBarWorkModeSave(settings: unknown, mode: string): { nativeTools: Block } {
  const current = nativeToolsOf(settings)
  const existingBackend = typeof current.executionBackend === 'string' ? current.executionBackend : null
  const executionBackend =
    mode === 'dangerous' ? 'local' : existingBackend && existingBackend !== 'local' ? existingBackend : 'apple_container'
  const change: Block = { bashAccessMode: mode, executionBackend }
  if (Object.prototype.hasOwnProperty.call(current, 'bashPolicyMode')) change.bashPolicyMode = null
  return { nativeTools: change }
}
