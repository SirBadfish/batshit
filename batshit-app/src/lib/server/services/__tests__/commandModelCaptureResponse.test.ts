import { describe, expect, it } from 'vitest'
import { attachCommandModelCapture, createCommandModelCapture } from '../commandModelCapture'
import { commandModelCaptureResponse, findCommandModelCapture } from '../commandModelCaptureResponse'

function capturedResult(chars: number) {
  const collector = createCommandModelCapture()
  collector.appendStdout('x'.repeat(chars))
  const capture = collector.finish({ exitCode: 0 })
  const result = attachCommandModelCapture({ success: true, stdout: 'visible' }, capture)
  return { capture, result }
}

describe('private command capture HTTP envelope', () => {
  it('follows only vouched result objects through known nested envelopes', async () => {
    const { capture, result } = capturedResult(100_000)
    const outer = { data: { output: { execution: result } } }

    expect(findCommandModelCapture(outer)).toBe(capture)
    const response = commandModelCaptureResponse(outer, true, 202)
    expect(response.status).toBe(202)
    expect(response.headers.get('x-batshit-command-model-capture')).toBe('1')
    expect(await response.json()).toEqual({ result: outer, modelCapture: capture })
    expect(JSON.stringify(outer)).not.toContain('modelCapture')
  })

  it('ignores a lookalike property and an untrusted JSON clone', async () => {
    const { capture, result } = capturedResult(100_000)
    const lookalike = { success: true, modelCapture: capture }
    const clone = JSON.parse(JSON.stringify(result))

    expect(findCommandModelCapture(lookalike)).toBeNull()
    expect(findCommandModelCapture(clone)).toBeNull()
    for (const value of [lookalike, clone]) {
      const response = commandModelCaptureResponse(value, true)
      expect(response.headers.get('x-batshit-command-model-capture')).toBeNull()
      expect(await response.json()).toEqual(value)
    }
  })

  it('keeps small, missing-capture, and signed-in session responses on the ordinary JSON lane', async () => {
    const { result: small } = capturedResult(1_000)
    const { result: large } = capturedResult(100_000)
    const plain = { success: true, stdout: 'ordinary' }

    for (const [value, agentRun] of [
      [small, true],
      [plain, true],
      [large, false]
    ] as const) {
      const response = commandModelCaptureResponse(value, agentRun)
      expect(response.headers.get('x-batshit-command-model-capture')).toBeNull()
      expect(await response.json()).toEqual(value)
      expect(JSON.stringify(value)).not.toContain('modelCapture')
    }
  })
})
