import { materializedToolSettingsProvider, RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS } from './toolSettingsMigration'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const retired = new Set<string>(RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS)
export class ToolSettingsWriteRefusal extends Error {
  readonly status = 400
  readonly code = 'tool_settings_explicit_choice_required'
}

/** Finite retirement guard; arbitrary provider/model siblings remain outside this rule. */
export function retiredOperationalToolWrite(providerPatch: unknown): string | null {
  if (!object(providerPatch)) return null
  for (const bag of [providerPatch, providerPatch.nativeTools, providerPatch.batshitNativeTools]) {
    if (!object(bag)) continue
    for (const key of Object.keys(bag)) if (retired.has(key)) return `${key} is now a global tool option in Admin. Nothing was saved.`
  }
  return null
}

/** Ordinary sparse writes cannot restore inheritance by deleting its canonical ancestors. */
export function explicitTypedFileToolsWriteIssue(providerPatch: unknown): string | null {
  if (providerPatch === null) return 'Keep the explicit Typed File Tools choice; clear individual provider settings instead. Nothing was saved.'
  if (!object(providerPatch)) return null // The existing provider shape validator owns this refusal.
  if (Object.hasOwn(providerPatch, 'nativeTools')) {
    const native = providerPatch.nativeTools
    if (native === null) return 'Keep the explicit Typed File Tools choice; clear individual tool settings instead. Nothing was saved.'
    if (object(native) && Object.hasOwn(native, 'artifactRuntimeEnabled') && typeof native.artifactRuntimeEnabled !== 'boolean') return 'Artifact Tools must be explicitly on or off. Nothing was saved.'
    if (object(native) && Object.hasOwn(native, 'typedFileToolsEnabled') && typeof native.typedFileToolsEnabled !== 'boolean') {
      return 'Typed File Tools must be explicitly on or off. Nothing was saved.'
    }
  }
  if (object(providerPatch.batshitNativeTools) && ['typedFileToolsEnabled', 'artifactRuntimeEnabled', 'nativeArtifactRuntimeEnabled'].some(key => Object.hasOwn(providerPatch.batshitNativeTools as object, key))) {
    return 'Change tool enable choices through the current nativeTools setting. Nothing was saved.'
  }
  return null
}

/** Creation/duplicate has its own new identity: absent chooses factoryfalse, explicit source survives. */
export function newSubjectToolSettings(provider: unknown): Record<string, unknown> {
  const issue = retiredOperationalToolWrite(provider)
  if (issue) throw new ToolSettingsWriteRefusal(issue)
  try { return materializedToolSettingsProvider(provider, { kind: 'absent' }) }
  catch (error) { throw new ToolSettingsWriteRefusal(error instanceof Error ? error.message : 'Tool settings are malformed. Nothing was saved.') }
}
