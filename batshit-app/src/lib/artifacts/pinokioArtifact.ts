/**
 * SA-072 P2 (DL-09, DL-10): the "Pinokio app" artifact lane, shared by the server and the
 * browser (no `$lib/server` imports).
 *
 * A Pinokio app artifact keeps its REAL kind in `metadata.source_type` (`comfyui`, `gradio`,
 * or `custom`), and adds:
 *
 * - `metadata.runtime_manager: "pinokio"`: Pinokio starts the app and reports where it is.
 * - `metadata.pinokio_app_id`: the installed app's folder id (`comfy.git`). Never a port, a
 *   URL, or a `pinokio://` ref: the address is resolved on every call (DL-10), and the ref
 *   carries the Mac's LAN address, which goes stale (P0, accepted DL-09 amendment).
 * - `metadata.pinokio_runtime`: the recipe Batshit's server runner follows to call the app's
 *   own HTTP API (DL-04), so the artifact can run from its panel AND as an agent tool
 *   (`use.artifact.{slug}`, DL-05).
 *
 * `brain_type: "pinokio_app"` is the completion transport that runs that recipe.
 */

export const PINOKIO_RUNTIME_MANAGER = 'pinokio'
export const PINOKIO_APP_BRAIN_TYPE = 'pinokio_app'

export type PinokioArtifactKind = 'comfyui' | 'gradio' | 'custom'
export const PINOKIO_ARTIFACT_KINDS: readonly PinokioArtifactKind[] = ['comfyui', 'gradio', 'custom']

export const PINOKIO_ARTIFACT_KIND_LABELS: Record<PinokioArtifactKind, string> = {
  comfyui: 'ComfyUI',
  gradio: 'Gradio',
  custom: 'Custom API'
}

/** One ComfyUI workflow input a Fabric field writes: `workflow[node].inputs[input]`. */
export interface PinokioComfyInputBinding {
  node: string
  input: string
}

export interface PinokioComfyRecipe {
  /** An API-format prompt (`{ "3": { class_type, inputs }, ... }`), never the UI graph. */
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  /** `fabricId` → the workflow input it fills. */
  inputs: Record<string, PinokioComfyInputBinding>
  /** A seed input that gets a fresh random value on every run where no field sets it. */
  randomSeed?: PinokioComfyInputBinding | null
}

/** One positional Gradio argument: a field's value, or a fixed value the artifact does not expose. */
export type PinokioGradioArgument = { field: string; file?: boolean } | { value: unknown }

export interface PinokioGradioRecipe {
  /** The endpoint's `api_name` as `/gradio_api/info` lists it, for example `/predict`. */
  api_name: string
  /** Every positional argument of that endpoint, in order. */
  inputs: PinokioGradioArgument[]
  /**
   * The returned values to keep, by position (0 = the first `returns` entry), in the order the run
   * should show them. Left out, every value is kept. An app often returns previews, status lines,
   * or slider updates beside its real result; list only the result.
   */
  outputs?: number[]
}

export interface PinokioCustomRecipe {
  method: 'POST'
  /** A path on the app, for example `/api/generate`. The field values are its JSON body. */
  path: string
}

export interface PinokioArtifactBinding {
  appId: string
  kind: PinokioArtifactKind
  runtime: Record<string, unknown> | null
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isPinokioKind(value: unknown): value is PinokioArtifactKind {
  return typeof value === 'string' && (PINOKIO_ARTIFACT_KINDS as readonly string[]).includes(value)
}

/** True when the artifact is managed by Pinokio (metadata), whatever else it claims. */
export function isPinokioManagedArtifact(artifact: any): boolean {
  return isRecord(artifact?.metadata) && artifact.metadata.runtime_manager === PINOKIO_RUNTIME_MANAGER
}

/** The app id, kind, and recipe of a Pinokio app artifact, or `null` for any other artifact. */
export function readPinokioArtifactBinding(artifact: any): PinokioArtifactBinding | null {
  if (!isPinokioManagedArtifact(artifact)) return null
  const metadata = artifact.metadata as Record<string, any>
  const appId = typeof metadata.pinokio_app_id === 'string' ? metadata.pinokio_app_id.trim() : ''
  const kind = isPinokioKind(metadata.source_type) ? metadata.source_type : null
  if (!appId || !kind) return null
  return {
    appId,
    kind,
    runtime: isRecord(metadata.pinokio_runtime) ? metadata.pinokio_runtime : null
  }
}

/** A Clip id as the chat's Clips roster lists it (`clip_1790381736423_2c5dee0b_0`). */
export const PINOKIO_CLIP_ID_PATTERN = /^clip_[A-Za-z0-9_-]+$/

/** How an agent's tool schema describes a file field of a Pinokio app artifact. */
export const PINOKIO_FILE_FIELD_HINT = 'a file: the Clip id from the Clips roster (clip_...), a public URL, or a data: URL'

/** The fields a Pinokio app artifact uploads to its app as files (Gradio `"file": true` arguments). */
export function pinokioFileFieldIds(artifact: any): Set<string> {
  const binding = readPinokioArtifactBinding(artifact)
  const inputs = binding?.kind === 'gradio' && Array.isArray(binding.runtime?.inputs) ? (binding.runtime.inputs as unknown[]) : []
  const ids = new Set<string>()
  for (const argument of inputs) {
    if (isRecord(argument) && argument.file === true && typeof argument.field === 'string') ids.add(argument.field)
  }
  return ids
}

/**
 * The same folder-id rule `pinokioService.pinokioAppIdProblem` enforces before `pterm` runs,
 * restated here because this module must stay browser-safe; `pinokioArtifact.test.ts` pins
 * the two to the same answers.
 */
export function pinokioArtifactAppIdProblem(appId: unknown): string | null {
  if (typeof appId !== 'string' || !appId.trim()) {
    return 'metadata.pinokio_app_id is required: the installed app folder id from sys.pinokio.search, such as comfy.git.'
  }
  const value = appId.trim()
  if (value.includes('://') || value.includes('@') || value.includes('/') || value.includes('\\') || value.startsWith('.')) {
    return 'metadata.pinokio_app_id must be one installed app folder id such as comfy.git, never a URL, a pinokio:// ref, a path, or id@host.'
  }
  if (value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value)) {
    return 'metadata.pinokio_app_id must be one installed app folder id from sys.pinokio.search (letters, digits, dots, dashes, underscores).'
  }
  return null
}

function fabricIds(metadata: Record<string, any>): Set<string> {
  const ids = new Set<string>()
  if (Array.isArray(metadata.fabric_fields)) {
    for (const field of metadata.fabric_fields) {
      if (isRecord(field) && typeof field.fabricId === 'string' && field.fabricId.trim()) ids.add(field.fabricId.trim())
    }
  }
  return ids
}

function comfyRecipeProblems(recipe: Record<string, any>, fields: Set<string>): string[] {
  const problems: string[] = []
  const workflow = recipe.workflow
  if (!isRecord(workflow) || Object.keys(workflow).length === 0) {
    return ['metadata.pinokio_runtime.workflow must be the API-format ComfyUI prompt: { "3": { "class_type": ..., "inputs": {...} }, ... }.']
  }
  if (Array.isArray((workflow as any).nodes)) {
    return [
      'metadata.pinokio_runtime.workflow is a UI workflow graph (nodes/links). Store the API-format prompt instead (in ComfyUI: Export (API)), or build it node by node.'
    ]
  }
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!isRecord(node) || typeof node.class_type !== 'string' || !isRecord(node.inputs)) {
      problems.push(`metadata.pinokio_runtime.workflow node "${nodeId}" needs a class_type and an inputs object.`)
    }
  }
  if (problems.length > 0) return problems

  const checkBinding = (label: string, binding: unknown) => {
    if (!isRecord(binding) || typeof binding.node !== 'string' || typeof binding.input !== 'string') {
      problems.push(`${label} must be { "node": "<node id>", "input": "<input name>" }.`)
      return
    }
    const node = (workflow as Record<string, any>)[binding.node]
    if (!isRecord(node)) {
      problems.push(`${label} names node "${binding.node}", which is not in the workflow.`)
      return
    }
    if (!(binding.input in node.inputs)) {
      problems.push(`${label} names input "${binding.input}", which node "${binding.node}" (${node.class_type}) does not have.`)
      return
    }
    if (Array.isArray(node.inputs[binding.input])) {
      problems.push(`${label} names input "${binding.input}" of node "${binding.node}", which is a link to another node, not a value.`)
    }
  }

  if (!isRecord(recipe.inputs)) {
    problems.push('metadata.pinokio_runtime.inputs must map each fabricId to { "node", "input" } in the workflow.')
  } else {
    for (const [fabricId, binding] of Object.entries(recipe.inputs)) {
      if (!fields.has(fabricId)) {
        problems.push(
          `metadata.pinokio_runtime.inputs names "${fabricId}", which is not a fabricId in metadata.fabric_fields.${
            /seed/i.test(fabricId) ? ' For a new seed on every run, set metadata.pinokio_runtime.randomSeed to { node, input } instead.' : ''
          }`
        )
        continue
      }
      checkBinding(`metadata.pinokio_runtime.inputs["${fabricId}"]`, binding)
    }
  }
  if (recipe.randomSeed != null) checkBinding('metadata.pinokio_runtime.randomSeed', recipe.randomSeed)
  return problems
}

function gradioRecipeProblems(recipe: Record<string, any>, fields: Set<string>): string[] {
  const problems: string[] = []
  if (typeof recipe.api_name !== 'string' || !recipe.api_name.trim().startsWith('/')) {
    problems.push('metadata.pinokio_runtime.api_name must be the endpoint name from the app\'s /gradio_api/info, such as "/predict".')
  }
  if (!Array.isArray(recipe.inputs)) {
    problems.push('metadata.pinokio_runtime.inputs must list every positional argument of that endpoint, in order: { "field": "<fabricId>" } or { "value": <fixed value> }.')
    return problems
  }
  recipe.inputs.forEach((argument: unknown, index: number) => {
    if (isRecord(argument) && typeof argument.field === 'string') {
      if (!fields.has(argument.field)) {
        problems.push(`metadata.pinokio_runtime.inputs[${index}] names field "${argument.field}", which is not a fabricId in metadata.fabric_fields.`)
      }
      return
    }
    if (isRecord(argument) && 'value' in argument) return
    problems.push(`metadata.pinokio_runtime.inputs[${index}] must be { "field": "<fabricId>" } or { "value": <fixed value> }.`)
  })
  if (recipe.outputs !== undefined) {
    const outputs = recipe.outputs
    const valid =
      Array.isArray(outputs) &&
      outputs.length > 0 &&
      outputs.every((entry: unknown) => Number.isInteger(entry) && (entry as number) >= 0) &&
      new Set(outputs).size === outputs.length
    if (!valid) {
      problems.push(
        'metadata.pinokio_runtime.outputs must list the returned values to keep by position, such as [0] for the first "returns" entry of /gradio_api/info (no repeats), or be left out to keep them all.'
      )
    }
  }
  return problems
}

function customRecipeProblems(recipe: Record<string, any>): string[] {
  const problems: string[] = []
  if (recipe.method !== 'POST') problems.push('metadata.pinokio_runtime.method must be "POST".')
  if (typeof recipe.path !== 'string' || !recipe.path.startsWith('/') || recipe.path.includes('://') || recipe.path.includes('..')) {
    problems.push('metadata.pinokio_runtime.path must be a path on the app that starts with "/", such as "/api/generate".')
  }
  return problems
}

/**
 * What stops a Pinokio app artifact from saving. A draft (`edit`) may leave the recipe out;
 * publishing needs it, because both the panel and `use.artifact` run through it.
 */
export function pinokioArtifactProblems(input: {
  brainType: unknown
  metadata: Record<string, any> | null | undefined
  mode: 'edit' | 'published' | string
}): string[] {
  const metadata = isRecord(input.metadata) ? input.metadata : {}
  const managed = metadata.runtime_manager === PINOKIO_RUNTIME_MANAGER
  const pinokioBrain = input.brainType === PINOKIO_APP_BRAIN_TYPE
  if (!managed && !pinokioBrain) return []
  if (metadata.runtime_manager != null && !managed) {
    return [`metadata.runtime_manager must be "${PINOKIO_RUNTIME_MANAGER}" or absent.`]
  }
  if (managed && !pinokioBrain) {
    return [`A Pinokio app artifact (metadata.runtime_manager "pinokio") needs brain_type "${PINOKIO_APP_BRAIN_TYPE}".`]
  }
  if (pinokioBrain && !managed) {
    return [`brain_type "${PINOKIO_APP_BRAIN_TYPE}" needs metadata.runtime_manager "pinokio" and metadata.pinokio_app_id.`]
  }

  const problems: string[] = []
  const appIdProblem = pinokioArtifactAppIdProblem(metadata.pinokio_app_id)
  if (appIdProblem) problems.push(appIdProblem)
  if (!isPinokioKind(metadata.source_type)) {
    problems.push('metadata.source_type must be the app\'s real kind: "comfyui", "gradio", or "custom" (never "pinokio").')
  }
  if ('pinokio_ref' in metadata) {
    problems.push('Remove metadata.pinokio_ref: it carries the machine\'s network address and goes stale. Batshit finds the app by metadata.pinokio_app_id on every call.')
  }
  if (problems.length > 0) return problems

  const recipe = metadata.pinokio_runtime
  if (recipe == null) {
    return input.mode === 'published'
      ? ['Publishing a Pinokio app artifact needs metadata.pinokio_runtime, the recipe Batshit follows to call the app (see the runtime-pinokio reference).']
      : []
  }
  if (!isRecord(recipe)) return ['metadata.pinokio_runtime must be an object.']
  const fields = fabricIds(metadata)
  if (metadata.source_type === 'comfyui') return comfyRecipeProblems(recipe, fields)
  if (metadata.source_type === 'gradio') return gradioRecipeProblems(recipe, fields)
  return customRecipeProblems(recipe)
}
