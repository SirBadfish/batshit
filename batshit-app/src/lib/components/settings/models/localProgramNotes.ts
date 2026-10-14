/**
 * What a local AI program says it is really running, told to the preset editor.
 *
 * SA-102 P4 (DL-102-04) added the context-size note: a preset stores a guess,
 * the program reports its allocation, and a smaller positive preset caps Batshit's prompt budget. BL-104
 * adds the model itself: KoboldCpp answers EVERY request with its one loaded
 * model, whatever `model` the request names, so after a switch a preset saved
 * for another model still runs, on the loaded one, and said nothing about it.
 *
 * User-facing copy names the program, never "runtime" (DL-102-16).
 */

import type { CatalogModel, LocalContextReading } from '$lib/types/modelCatalog'

export type LocalProgramNote = {
  tone: '' | 'is-warning'
  text: string
}

export type LocalContextNote = LocalProgramNote & {
  /** LM Studio's unload countdown, when it gives one. */
  ttl: string | null
}

/**
 * BL-104: the catalog row whose model this program answers every request with,
 * or null when the program serves no single model (or is not a local program).
 * `/api/models` marks that row (`servesEveryRequest`); only KoboldCpp does today.
 */
export function findServingModel(
  catalog: readonly CatalogModel[],
  programId: string | null | undefined
): CatalogModel | null {
  if (!programId) return null
  const connectionId = `direct:${programId}`
  return (
    catalog.find((model) => model.servesEveryRequest === true && model.connectionId === connectionId) ??
    null
  )
}

/**
 * A local model's name without the program's own namespace, the way the
 * program's Local AI card names it: KoboldCpp lists `koboldcpp/<file name>`.
 * Only that exact prefix goes; any other owner stays part of the name.
 */
export function localModelName(programId: string, modelId: string): string {
  const name = modelId.trim()
  const prefix = `${programId}/`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * BL-104: the note under Model ID when the program serves another model to
 * every request. Names are compared exactly, as the program spells them, after
 * dropping its own prefix, so `Llama-3.2-3B-Instruct-Q4_K_M` and
 * `koboldcpp/Llama-3.2-3B-Instruct-Q4_K_M` are the same model.
 */
export function describeServedModelNote(args: {
  programId: string | null | undefined
  programLabel: string | null | undefined
  presetModelId: string | null | undefined
  serving: CatalogModel | null | undefined
}): LocalProgramNote | null {
  const { programId, programLabel, serving } = args
  const presetModelId = args.presetModelId?.trim() ?? ''
  if (!programId || !programLabel || !serving || !presetModelId) return null

  const served = localModelName(programId, serving.name)
  if (!served || localModelName(programId, presetModelId) === served) return null

  return {
    tone: 'is-warning',
    text: `${programLabel} is serving ${served}, not the model above. Replies from this preset come from ${served}.`
  }
}

/**
 * SA-102 P4 (DL-102-04): what the program says it is ACTUALLY running a model
 * with, next to the size the preset stores.
 *
 * Three states, each said out loud: a real loaded number, "not loaded yet" for
 * a program that would tell us once it is, and nothing at all for a program
 * that never reports. The ceiling is never presented as the truth.
 *
 * BL-104: `runningModelName` is set when the preset names a model the program
 * is not serving; the size then belongs to the served model, so the note names
 * it instead of saying "this model".
 */
export function describeLocalContextNote(args: {
  programId?: string | null
  programLabel: string | null | undefined
  reading: LocalContextReading | null | undefined
  presetContextWindow: number | null
  requestedContextWindow?: number | null
  runningModelName: string | null
}): LocalContextNote | null {
  const { programLabel: program, reading, runningModelName } = args
  if (!program) return null

  const preset = typeof args.presetContextWindow === 'number' && Number.isFinite(args.presetContextWindow) && args.presetContextWindow > 0
    ? args.presetContextWindow : null
  const requested = args.programId === 'ollama' && typeof args.requestedContextWindow === 'number' &&
    Number.isFinite(args.requestedContextWindow) && args.requestedContextWindow > 0
      ? args.requestedContextWindow : null
  if (requested !== null) {
    const planned = preset !== null ? Math.min(preset, requested) : requested
    return { tone: '', ttl: null,
      text: `${program} will be asked to use ${requested.toLocaleString()} tokens for this request.` +
        (planned < requested ? ` Batshit plans against the smaller preset limit of ${planned.toLocaleString()} tokens.` : '') }
  }
  if (!reading) return null
  if (reading.source === 'loaded' && typeof reading.loadedContextWindow === 'number') {
    const loaded = reading.loadedContextWindow
    const planned = preset !== null ? Math.min(preset, loaded) : loaded
    const subject = runningModelName ?? 'this model'
    const increaseHint = args.programId === 'koboldcpp'
      ? ' To increase this loaded ceiling, restart KoboldCpp with a larger Context Size (--contextsize). Changing this preset does not enlarge it.' : ''
    return {
      tone: preset && preset !== loaded ? 'is-warning' : '',
      text:
        preset && preset !== loaded
          ? `${program} is running ${subject} at ${loaded.toLocaleString()} tokens, not the ${preset.toLocaleString()} above. Batshit plans against ${planned.toLocaleString()}.${increaseHint}`
          : `${program} is running ${subject} at ${loaded.toLocaleString()} tokens.${increaseHint}`,
      ttl:
        typeof reading.remainingTtlSeconds === 'number'
          ? `${program} unloads it in about ${Math.max(1, Math.round(reading.remainingTtlSeconds / 60))} minutes, after which this becomes unknown again.`
          : null
    }
  }
  return {
    tone: '',
    text: `${program} can tell Batshit the real size, but only while the model is loaded. Load it and refresh the model catalog to see the number.`,
    ttl: null
  }
}
