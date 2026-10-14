/**
 * The input keys an agent's `use.artifact.{slug}` call keeps for itself. `artifact.typed.invoke`
 * reads a flat input, so a field with one of these names would be taken as the control key and
 * never reach the artifact (a Pinokio OCR app's `model` field became the AI model override and
 * the app ran with no model). A save refuses them; `prompt` stays allowed, because an artifact
 * may expose its prompt as a real field. Shared by the registry and the artifacts service.
 */
export const ARTIFACT_INVOKE_RESERVED_KEYS: readonly string[] = [
  'mode',
  'context',
  'sessionId',
  'model',
  'webhook_url',
  'artifactId',
  'shareToChat',
  'share_to_chat',
  'artifactName',
  'artifact_name'
]

const RESERVED = new Set(ARTIFACT_INVOKE_RESERVED_KEYS)

/** The `metadata.fabric_fields` ids an agent could never set, with the rename to use. */
export function reservedFabricFieldProblems(metadata: Record<string, any> | null | undefined): string[] {
  const fields = metadata && Array.isArray(metadata.fabric_fields) ? metadata.fabric_fields : []
  const problems: string[] = []
  for (const field of fields) {
    const id = typeof field?.fabricId === 'string' ? field.fabricId.trim() : ''
    if (!RESERVED.has(id)) continue
    problems.push(
      `metadata.fabric_fields fabricId "${id}" is reserved for the agent's run call, so an agent could never set it. Rename it, for example "${id === 'model' ? 'model_name' : `${id}_value`}", in the field and everywhere the artifact uses it.`
    )
  }
  return problems
}
