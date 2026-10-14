/**
 * Zip control permission: whether an agent may zip and unzip through Batshit's zip-control block
 * (`zip-architecture.md`, "Zip Control Permission").
 *
 * SA-129 DL-06 (BL-1484): the permission is PARKED for a later experiment with frontier models.
 * Hold and Release replaced it, and no Settings surface reads or writes it. It is ON only when the
 * explicit experiment key `zip_agent_control_experiment` is exactly `true`: the agent's own key
 * wins (`true` or `false`), else the user's `global_zip_settings` key, else OFF. To run the
 * experiment, set that key on the record in Redis.
 *
 * The older keys, `zip_agent_control_enabled` and the legacy `zip_control_mode`, are IGNORED
 * everywhere. Most stored `true` values came from BL-231 (the Global Tool Grid showed ON with
 * nothing saved, and its first save turned it on), not from a choice. They are ignored here, and the
 * startup integrity pass removes them from every record (`retiredZipControlFields.ts`, Josh
 * 2026-10-13: no compatibility to keep).
 *
 * The compiler (what the agent is told, and which zip prompt it gets) and the reply-end step
 * (whether a reply's zip actions apply) both read this module.
 */

export const DEFAULT_ZIP_AGENT_CONTROL_ENABLED = false

/** The one key that turns the parked permission on, on an agent record or `global_zip_settings`. */
export const ZIP_AGENT_CONTROL_EXPERIMENT_FIELD = 'zip_agent_control_experiment'

/** An agent record or a `global_zip_settings` block; only its experiment key is read. */
type ZipControlFields = { readonly [field: string]: unknown } | null | undefined

/** The block's own answer: `true` or `false` when it sets the key to a boolean, else none. */
function readExperimentKey(fields: ZipControlFields): boolean | undefined {
  const value = fields?.[ZIP_AGENT_CONTROL_EXPERIMENT_FIELD]
  return typeof value === 'boolean' ? value : undefined
}

/** The global default: ON only when the user's `global_zip_settings` key is exactly `true`. */
export function resolveGlobalZipAgentControlPermission(globalZipSettings: ZipControlFields): boolean {
  return readExperimentKey(globalZipSettings) ?? DEFAULT_ZIP_AGENT_CONTROL_ENABLED
}

/** What one agent gets: its own experiment key, else the global one. */
export function resolveZipAgentControlPermission(
  agent: ZipControlFields,
  globalZipSettings: ZipControlFields
): boolean {
  return readExperimentKey(agent) ?? resolveGlobalZipAgentControlPermission(globalZipSettings)
}
