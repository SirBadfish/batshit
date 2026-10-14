import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'

/**
 * SA-124 P1: KoboldCpp's seven samplers, in the order its own code lists them.
 * The index IS the identity — `sampler_order` is an array of these numbers —
 * so this list must never be reordered, only read.
 */
export const KOBOLDCPP_SAMPLER_SLOTS = [
  'Top K',
  'Top A',
  'Top P',
  'Tail-free',
  'Typical',
  'Temperature',
  'Repeat penalty'
] as const

/** KoboldCpp's own default order. */
export const KOBOLDCPP_DEFAULT_SAMPLER_ORDER = [6, 0, 1, 3, 4, 2, 5]

/**
 * A sampler order is valid only if it is a permutation of all seven slots.
 * A partial or duplicated list would silently drop a sampler, so a bad value is
 * rejected rather than sent.
 */
export function parseSamplerOrder(raw: unknown): number[] | undefined {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/).filter(Boolean)
      : null
  if (!list) return undefined
  const numbers = list.map((entry) => Number(entry))
  if (numbers.length !== KOBOLDCPP_SAMPLER_SLOTS.length) return undefined
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n >= KOBOLDCPP_SAMPLER_SLOTS.length)) {
    return undefined
  }
  if (new Set(numbers).size !== numbers.length) return undefined
  return numbers
}

function stripNumericFormatting(raw: string) {
  return raw.replace(/[$,\s]/g, '')
}

/** Typed escapes become the real characters. Unknown escapes are left alone. */
function unescapeEntry(entry: string): string {
  return entry.replace(/\\(n|t|r|"|\\)/g, (_match, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char
  )
}

/**
 * BL-866: the choice a saved select value means for THIS model. A definition that names a
 * `savedValueAliases` entry for the saved value gets the replacement; every other value comes
 * back as it was saved. The Models panel shows this value and the mapper sends it.
 */
export function resolveSavedSelectValue(definition: ParameterDefinition, value: string): string {
  return definition.savedValueAliases?.[value] ?? value
}

/**
 * BL-866: a sentence for a saved select value that a definition with `onlyListedValues` does not
 * offer (after its alias), or `null` when the value is offered, blank, or the definition does
 * not ask for the check. The mapper refuses the send with this sentence (naming the model when
 * it knows it); the Models panel shows it beside the field.
 */
export function describeUnlistedSelectValue(
  definition: ParameterDefinition,
  value: string,
  modelId?: string | null
): string | null {
  if (!definition.onlyListedValues) return null
  const saved = value.trim()
  if (!saved.length) return null
  const resolved = resolveSavedSelectValue(definition, saved)
  const options = definition.options ?? []
  if (options.some((option) => option.value === resolved)) return null
  const choices = options.map((option) => option.label).join(' or ')
  const target = modelId?.trim() ? modelId.trim() : 'this model'
  return `${definition.label} "${saved}" is not available on ${target}. Choose ${choices}, or clear it.`
}

export function toInputValue(definition: ParameterDefinition, value?: ParameterValue): string {
  if (value === undefined || value === null) return ''

  switch (definition.inputType) {
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      if (typeof value === 'string') return value === 'true' ? 'true' : value === 'false' ? 'false' : ''
      return ''
    case 'number':
    case 'integer':
      return typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
    case 'string-array':
      if (Array.isArray(value)) {
        const shown = definition.unescapeEntries
          ? value.map((entry) =>
              String(entry)
                .replace(/\\/g, '\\\\')
                .replace(/\n/g, '\\n')
                .replace(/\t/g, '\\t')
                .replace(/\r/g, '\\r')
            )
          : value
        return shown.join(definition.arrayDelimiter === 'comma' ? ', ' : '\n')
      }
      return typeof value === 'string' ? value : ''
    case 'sampler-order': {
      const parsed = parseSamplerOrder(value)
      return parsed ? parsed.join(',') : ''
    }
    case 'json':
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value, null, 2)
      } catch {
        return ''
      }
    case 'select':
      // BL-866: what the picker shows for a saved choice this model replaces.
      return typeof value === 'string' ? resolveSavedSelectValue(definition, value) : String(value)
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

export function fromInputValue(
  definition: ParameterDefinition,
  raw: string
): ParameterValue | undefined {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed.length) {
    return undefined
  }

  switch (definition.inputType) {
    case 'boolean':
      if (trimmed === 'true') return true
      if (trimmed === 'false') return false
      return undefined
    case 'select':
      // SA-102 follow-up: a three-state boolean is a select so it can express
      // "not set" (''), which the empty-string guard above already returns as
      // undefined. Its two real values must come back as REAL booleans, or the
      // provider option would carry the string "false".
      if (definition.booleanTriState) {
        if (trimmed === 'true') return true
        if (trimmed === 'false') return false
        return undefined
      }
      return trimmed
    case 'number': {
      const parsed = Number(stripNumericFormatting(trimmed))
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'integer': {
      const parsed = parseInt(stripNumericFormatting(trimmed), 10)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'sampler-order':
      // An invalid order returns undefined, which means "do not send" — better
      // than quietly shipping a list that drops a sampler.
      return parseSamplerOrder(trimmed)
    case 'string-array': {
      const delimiter = definition.arrayDelimiter === 'comma' ? ',' : '\n'
      const segments = trimmed.split(delimiter).map((segment) => segment.trim())
      const filtered = segments.filter(Boolean)
      if (!filtered.length) return undefined
      return definition.unescapeEntries ? filtered.map(unescapeEntry) : filtered
    }
    case 'json':
      try {
        return JSON.parse(trimmed)
      } catch {
        return undefined
      }
    default:
      return trimmed
  }
}

export function formatDefaultInput(definition: ParameterDefinition) {
  if (definition.defaultValue === undefined) return ''
  return toInputValue(definition, definition.defaultValue)
}
