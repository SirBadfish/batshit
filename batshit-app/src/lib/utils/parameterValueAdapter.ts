import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'

function stripNumericFormatting(raw: string) {
  return raw.replace(/[$,\s]/g, '')
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
        return value.join(definition.arrayDelimiter === 'comma' ? ', ' : '\n')
      }
      return typeof value === 'string' ? value : ''
    case 'json':
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value, null, 2)
      } catch {
        return ''
      }
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
    case 'number': {
      const parsed = Number(stripNumericFormatting(trimmed))
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'integer': {
      const parsed = parseInt(stripNumericFormatting(trimmed), 10)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'string-array': {
      const delimiter = definition.arrayDelimiter === 'comma' ? ',' : '\n'
      const segments = trimmed.split(delimiter).map((segment) => segment.trim())
      const filtered = segments.filter(Boolean)
      return filtered.length ? filtered : undefined
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
