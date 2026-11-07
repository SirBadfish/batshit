import { describe, expect, it } from 'vitest'
import { buildSchemaSummary, formatCliSchemaHint, getSchemaHintText } from '../dynamicMcpSchema'

const caps = { requiredLimit: 20, optionalLimit: 20, maxChars: 1000 }
const hint = (schema: unknown, overrides = {}) => getSchemaHintText(buildSchemaSummary(schema, { ...caps, ...overrides }))!

describe('schema hints', () => {
  it('marks malformed required metadata incomplete without inventing null/object field names', () => {
    const text = hint({ properties: { query: { type: 'string' } }, required: [null, {}] })
    expect(text).toContain('required metadata unavailable: full schema')
    expect(text).toContain('query:string')
    expect(text).not.toContain('null:')
    expect(text).not.toContain('[object Object]')
  })

  it('keeps enums, zero/false defaults, limits and array element types in required/optional groups', () => {
    const text = hint({ properties: {
      mode: { enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], default: 'i' },
      count: { type: 'integer', minimum: 0, maximum: 12, default: 0 },
      enabled: { type: 'boolean', default: false },
      names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 }
    }, required: ['mode'] })
    expect(text).toContain('required: mode:a|b|c|d|e|f|g|h|i (default "i")')
    expect(text).toContain(' · optional: count:integer (min 0; max 12; default 0)')
    expect(text).toContain('enabled:boolean (default false)')
    expect(text).toContain('names:array<string> (min items 1; max items 6)')
  })

  it('shows omitted required and optional counts when field limits or character caps apply', () => {
    const schema = { properties: {
      first: { type: 'string' }, second: { type: 'string' }, optionalOne: { type: 'boolean' }, optionalTwo: { type: 'boolean' }
    }, required: ['first', 'second'] }
    expect(hint(schema, { requiredLimit: 1, optionalLimit: 0 })).toBe('required: first:string (+1 more; full schema) · optional: 2 fields (full schema)')
    const reduced = buildSchemaSummary(schema, { requiredLimit: 20, optionalLimit: 20, maxChars: 80 })!
    expect(reduced.truncated).toBe(true)
    expect(reduced.text!.length).toBeLessThanOrEqual(80)
    expect(reduced.text).toContain('full schema')
    expect(hint({ properties: { ['long'.repeat(80)]: { type: 'string' } }, required: ['long'.repeat(80)] }, { maxChars: 80 })).toBe('required: 1 fields (full schema)')
  })

  it('identifies unresolved branches and nested shapes without inferring their requiredness', () => {
    expect(hint({ oneOf: [{ required: ['a'] }, { required: ['b'] }] })).toBe('conditional requirements: full schema')
    expect(hint({ properties: { config: { type: 'object', properties: { value: { type: 'string' } } }, ref: { $ref: '#/$defs/Input' } }, dependentRequired: { config: ['ref'] } })).toContain('conditional requirements: full schema')
    expect(hint({ properties: { config: { type: 'object', properties: { value: { type: 'string' } } } } })).toContain('config:object (full schema)')
    expect(hint({ properties: { config: { type: 'string', allOf: [{ pattern: '^x' }] } } })).toContain('config:string (full schema)')
    expect(hint({ properties: { workers: { type: 'array', items: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } }, required: ['workers'] })).toContain('workers:array<object (full schema)>')
    expect(hint({ properties: { query: { type: 'string' } }, required: ['token'] })).toContain('required: token:unknown (full schema)')
  })

  it('includes every CLI field and both real required-field representations', () => {
    const text = formatCliSchemaHint({ properties: {
      first: { type: 'string', required: true }, second: { type: 'number' },
      third: { type: 'boolean' }, fourth: { type: 'array', items: { type: 'string' } },
      fifth: { type: 'string', enum: ['small', 'large'] }
    }, required: ['second'] })
    expect(text).toBe('required: first:string, second:number · optional: third:boolean, fourth:array<string>, fifth:small|large')
    expect(formatCliSchemaHint({ properties: { first: { type: 'string', required: true }, second: { type: 'string', required: true }, third: { type: 'boolean' } } }, {
      requiredLimit: 1, optionalLimit: 0, maxChars: 1000
    })).toBe('required: first:string (+1 more; full schema) · optional: 1 fields (full schema)')
  })
})
