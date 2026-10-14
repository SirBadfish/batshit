import type { SubagentRow } from '$lib/types/database'

function cloneProviderSettings(value: Record<string, any> | null | undefined): Record<string, any> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return structuredClone(value)
}

/**
 * The provider settings a managed CLI Subagent or CLI Worker run launches with: the Subagent's
 * own, with the helper's Fetch Zip tool and the Batshit Tools toggle turned off (the CLI profile
 * never carries the Fabric control plane, SA-064).
 *
 * One definition, read in two places, so they cannot drift (BL-81 follow-up): the runner hands
 * these settings to the bridge, which decides the helper's families from them, and
 * `resolveManagedSubagentScope` reads a CLI run's native tool settings from them, which is what
 * the run's DCM index and the control list on its credential are built from. What the DCM
 * offers, what the helper exposes, and what the routes allow are therefore one set.
 */
export function buildCliSubagentProviderSettings(subagent: SubagentRow): Record<string, any> {
  const base = cloneProviderSettings(subagent.provider_specific_settings ?? null)
  const nativeTools =
    base.nativeTools && typeof base.nativeTools === 'object'
      ? { ...base.nativeTools }
      : base.batshitNativeTools && typeof base.batshitNativeTools === 'object'
        ? { ...base.batshitNativeTools }
        : {}

  nativeTools.fetchZipEnabled = false
  nativeTools.batshitToolsEnabled = false

  base.nativeTools = nativeTools
  delete base.batshitNativeTools

  return base
}
