import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectAsyncRecordedSource, inspectElevenMedicalSource, inspectOpenaiRecordedSource } from '../services/builtinVoiceCatalogRecordedSources'
import { inspectAsyncRecordedOperation } from '../services/builtinVoiceCatalogAsyncOperation'

describe('finite recorded voice source contracts', () => {
  it('treats missing, malformed or unbound documents as insufficient', () => {
    expect(inspectOpenaiRecordedSource('', '')).toEqual({ state: 'insufficient' })
    expect(inspectElevenMedicalSource('scribe_v2_medical')).toEqual({ state: 'insufficient' })
    expect(inspectAsyncRecordedSource('async_asr_v1.0', '<script>not an operation</script>')).toEqual({ state: 'insufficient' })
  })

  it.skipIf(!process.env.VOICE_RECORDING_CAPTURE_ROOT)('binds the actual current fixed documents and refuses contradictions', () => {
    const root = process.env.VOICE_RECORDING_CAPTURE_ROOT!
    const read = (name: string) => readFileSync(`${root}/${name}`, 'utf8')
    const workflow = read('openai-workflows.md'), file = read('openai-file.md')
    const eleven = read('eleven-models.md'), models = read('async-models.html'), endpoint = read('async-asr.html')
    expect(inspectOpenaiRecordedSource(workflow, file)).toEqual({ state: 'matches' })
    expect(inspectOpenaiRecordedSource(workflow, file.replace('For `gpt-transcribe`, `languages` replaces', 'For `gpt-transcribe`, an additional private field is required. `languages` replaces'))).toEqual({ state: 'insufficient' })
    expect(inspectOpenaiRecordedSource(workflow, file.replace('For `gpt-transcribe`, `languages` replaces', 'For `gpt-transcribe`, documentation says it does not support file_metadata. `languages` replaces'))).toEqual({ state: 'insufficient' })
    expect(inspectOpenaiRecordedSource(workflow, file.replace('- Regional `zh` locale codes', '  - Regional `zh` locale codes'))).toEqual({ state: 'insufficient' })
    expect(inspectElevenMedicalSource(eleven)).toEqual({ state: 'matches' })
    expect(inspectElevenMedicalSource(eleven.replace('Same request shape as Scribe v2', 'Different request shape from Scribe v2'))).toEqual({ state: 'insufficient' })
    expect(inspectElevenMedicalSource(eleven.replace('## Scribe v2 Medical\n', '## Scribe v2 Medical\n\nScribe v2 Medical does not use a different API.\n'))).toEqual({ state: 'insufficient' })
    expect(inspectAsyncRecordedSource(models, endpoint)).toEqual({ state: 'matches' })
    const regex = /window\.__remixContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/
    const match = endpoint.match(regex)!
    const graph = JSON.parse(JSON.parse(match[1])) as unknown[]
    const name = graph.indexOf('multipart/form-data'), replacement = graph.push('application/json') - 1
    const mutated = graph.slice()
    mutated[name] = graph[replacement]
    const changed = endpoint.replace(match[1], JSON.stringify(JSON.stringify(mutated)))
    expect(inspectAsyncRecordedOperation(changed)).toBe('changed')
    expect(inspectAsyncRecordedOperation(endpoint.replace(match[1], '"invalid"'))).toBe('insufficient')
    const graphCase = (edit: (copy: any[], op: Record<string, number>, key: (name: string) => string) => void) => {
      const copy = structuredClone(graph) as any[]
      const key = (name: string) => `_${copy.indexOf(name)}`
      const op = copy.find(value => value && !Array.isArray(value) && typeof value === 'object' && copy[value[key('id')]] === 39464639 && value[key('requestBody')] !== undefined)
      edit(copy, op, key)
      return endpoint.replace(match[1], JSON.stringify(JSON.stringify(copy)))
    }
    const reordered = graphCase((copy, op, key) => { copy[copy[op[key('parameters')]][key('header')]].reverse(); copy[copy[op[key('requestBody')]][key('parameters')]].reverse() })
    expect(inspectAsyncRecordedOperation(reordered)).toBe('matches')
    const addedConstraint = graphCase((copy, op, key) => {
      const body = copy[op[key('requestBody')]], schema = copy[body[key('jsonSchema')]]
      const keyIndex = copy.push('allOf') - 1, valueIndex = copy.push([]) - 1
      schema[`_${keyIndex}`] = valueIndex
    })
    expect(inspectAsyncRecordedOperation(addedConstraint)).toBe('insufficient')
    const requiredLanguage = graphCase((copy, op, key) => {
      const body = copy[op[key('requestBody')]]
      const param = copy[body[key('parameters')]].map((index: number) => copy[index]).find((value: Record<string, number>) => copy[value[key('name')]] === 'language')
      param[key('required')] = copy.indexOf(true)
    })
    expect(inspectAsyncRecordedOperation(requiredLanguage)).toBe('changed')
    const changedPath = graphCase((copy, op, key) => { op[key('path')] = copy.push('https://api.async.com/other') - 1 })
    expect(inspectAsyncRecordedOperation(changedPath)).toBe('changed')
  })
})
