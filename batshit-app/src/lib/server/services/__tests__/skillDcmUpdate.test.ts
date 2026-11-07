import { describe, expect, it } from 'vitest'
import { applySkillDcmUpdate, createSkillDcmUpdate } from '../skillDcmUpdate'
import { ApiImageInputCollector } from '../imageAddressApiInput'
const old = '<dynamic_info>\nproject_path: /project\n</dynamic_info>'
const fresh = '<dynamic_info>\nopen_skills:\n- Example\n  - fabric:sys.example.use — required: `id`\nproject_path: /project\n</dynamic_info>'
const before = `<conversation>original user history</conversation>\n\n<user>actual request</user>\n\n${old}`
const after = before.replace(old, fresh)
function token() { return createSkillDcmUpdate(before, before.indexOf(old), old, fresh, 'open_skills:\n- Example\n  - fabric:sys.example.use — required: `id`') }
describe('canonical skill DCM span replacement', () => {
  it('preserves all surrounding compiled text and provider cache markers across split parts', () => {
    const split = before.indexOf('<user>')
    const messages = [{ role: 'user', content: [{ type: 'text', text: before.slice(0, split), providerOptions: { cache: 'original' } }, { type: 'text', text: before.slice(split) }] }]
    const changed = applySkillDcmUpdate(messages, token())
    expect(changed[0].content[0]).toBe(messages[0].content[0])
    expect(changed[0].content.map((part: any) => part.text).join('')).toBe(after)
    expect(messages[0].content.map(part => part.text).join('')).toBe(before)
  })
  it('accepts only the exact server replacement and refuses forged or changed spans', () => {
    expect(() => applySkillDcmUpdate([{ role: 'user', content: before }], {} as any)).toThrow('server run')
    expect(() => applySkillDcmUpdate([{ role: 'user', content: before.replace('actual request', 'changed') }], token())).toThrow('span changed')
    expect(() => applySkillDcmUpdate([{ role: 'user', content: before }, { role: 'user', content: before }], token())).toThrow('span changed')
  })
  it('accounts the observed new guidance as Batshit and retains original compiled-prefix proof', () => {
    const collector = new ApiImageInputCollector()
    collector.observe({ compiledMessages: [{ role: 'user', content: before }], compiledPrefixCount: 1, initialSystem: null,
      promptMessages: [{ role: 'user', content: after }], toolDefinitions: [], userSources: [], skillDcmUpdates: [token()] })
    expect(collector.compiledObserved).toBe(true)
    expect(collector.run.unaccountedInputs).toBe(0)
    expect(collector.run.pieces).toEqual([{ source: 'batshit', text: expect.stringContaining('fabric:sys.example.use') }])
    const forged = new ApiImageInputCollector()
    forged.observe({ compiledMessages: [{ role: 'user', content: before }], compiledPrefixCount: 1, initialSystem: null,
      promptMessages: [{ role: 'user', content: after }], toolDefinitions: [], userSources: [], skillDcmUpdates: [{} as any] })
    expect(forged.compiledObserved).toBe(false)
    expect(forged.run.unaccountedInputs).toBeGreaterThan(0)
  })
})
