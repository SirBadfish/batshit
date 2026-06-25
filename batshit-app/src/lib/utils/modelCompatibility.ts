import type { SavedModel } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import {
  filterParameters,
  isParameterSupportedInN8N,
  type ParameterFilterArgs
} from '$lib/utils/parameterFilter'

interface SettingsArgs extends ParameterFilterArgs {
  settings?: Record<string, ParameterValue | undefined> | null
}

export function filterSettingsForN8N(args: SettingsArgs): Record<string, ParameterValue> | null {
  if (!args.settings || Object.keys(args.settings).length === 0) {
    return null
  }

  const definitions = filterParameters(args)
  if (!definitions.length) {
    return null
  }

  const allowed = new Map(definitions.map((definition) => [definition.name, definition]))
  const filtered: Record<string, ParameterValue> = {}

  for (const [key, value] of Object.entries(args.settings)) {
    if (value === undefined || value === null) continue
    const definition = allowed.get(key)
    if (!definition) continue
    if (!isParameterSupportedInN8N(definition, {
      provider: args.provider,
      model: args.modelId ?? args.vercelId,
      matrixEntries: args.matrixEntries
    })) continue
    filtered[key] = value
  }

  return Object.keys(filtered).length ? filtered : null
}

export function listUnsupportedN8NParameters(
  model?: SavedModel | null,
  options?: { matrixEntries?: SettingsArgs['matrixEntries'] }
): string[] {
  if (!model || !model.settings) {
    return []
  }

  const connectionType = model.connection?.type ?? null
  const provider =
    connectionType === 'direct'
      ? model.connection?.service ?? model.provider
      : connectionType ?? model.provider

  return listUnsupportedParameters({
    provider,
    modelId: model.modelId,
    vercelId: model.vercelSourceId ?? undefined,
    capabilities: model.capabilities ?? null,
    settings: model.settings,
    matrixEntries: options?.matrixEntries ?? null
  })
}

export function listUnsupportedParameters(args: SettingsArgs): string[] {
  if (!args.settings || Object.keys(args.settings).length === 0) {
    return []
  }

  const definitions = filterParameters(args)
  if (!definitions.length) {
    return []
  }

  const lookup = new Map(definitions.map((definition) => [definition.name, definition]))
  const unsupported: string[] = []

  for (const [key, value] of Object.entries(args.settings)) {
    if (value === undefined || value === null) continue
    const definition = lookup.get(key)
    if (!definition) {
      unsupported.push(key)
      continue
    }
    if (!isParameterSupportedInN8N(definition, {
      provider: args.provider,
      model: args.modelId ?? args.vercelId,
      matrixEntries: args.matrixEntries
    })) {
      unsupported.push(definition.label || key)
    }
  }

  return unsupported
}

export function listUnsupportedParameterKeys(args: SettingsArgs): string[] {
  if (!args.settings || Object.keys(args.settings).length === 0) {
    return []
  }

  const definitions = filterParameters(args)
  if (!definitions.length) {
    return []
  }

  const lookup = new Map(definitions.map((definition) => [definition.name, definition]))
  const unsupported: string[] = []

  for (const [key, value] of Object.entries(args.settings)) {
    if (value === undefined || value === null) continue
    const definition = lookup.get(key)
    if (!definition) {
      unsupported.push(key)
      continue
    }
    if (!isParameterSupportedInN8N(definition, {
      provider: args.provider,
      model: args.modelId ?? args.vercelId,
      matrixEntries: args.matrixEntries
    })) {
      unsupported.push(key)
    }
  }

  return unsupported
}
