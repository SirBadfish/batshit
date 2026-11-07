import { describe, expect, it } from 'vitest'
import { attachCommandModelCapture, createCommandModelCapture } from '../commandModelCapture'
import { findCommandModelCapture } from '../commandModelCaptureLookup'

describe('in-process command capture lookup', () => {
  it('follows only vouched result objects through known nested envelopes', () => {
    const collector = createCommandModelCapture()
    collector.appendStdout('x'.repeat(100_000))
    const capture = collector.finish({ exitCode: 0 })
    const result = attachCommandModelCapture({ success: true, stdout: 'visible' }, capture)
    const outer = { data: { output: { execution: result } } }
    expect(findCommandModelCapture(outer)).toBe(capture)
    expect(JSON.stringify(outer)).not.toContain('modelCapture')
    expect(findCommandModelCapture({ success: true, modelCapture: capture })).toBeNull()
    expect(findCommandModelCapture(JSON.parse(JSON.stringify(result)))).toBeNull()
  })
})
