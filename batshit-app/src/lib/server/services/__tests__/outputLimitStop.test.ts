import { describe, expect, it } from 'vitest'
import { isContextExhaustionError } from '../contextExhaustion'
import {
  OUTPUT_LIMIT_ERROR_CODE,
  OUTPUT_LIMIT_FAILURE_KIND,
  describeOutputLimitStop,
  isOutputLimitFinish,
  outputLimitFailureMetadata,
} from '../outputLimitStop'

/**
 * BL-239: a reply whose last model request stopped at the output limit. Seen on the SA-126
 * benchmark instance: GLM 5.3 thought for 65,534 tokens, stopped at dashscope-intl's default
 * limit of 65,536 (finish reason `length`), and the saved reply was "I", shown as finished.
 */
describe('outputLimitStop', () => {
  it('only a `length` finish is the output limit', () => {
    expect(isOutputLimitFinish('length')).toBe(true)
    for (const other of ['stop', 'tool-calls', 'content-filter', 'error', 'other', 'unknown', null, undefined, 'LENGTH']) {
      expect(isOutputLimitFinish(other)).toBe(false)
    }
  })

  it('names the limit it reached, and tells the user what to do', () => {
    const wrote = describeOutputLimitStop({ outputTokens: 65536, wroteReply: true })
    expect(wrote).toBe(
      'The model reached its output limit of 65,536 tokens before this reply was finished. Ask the agent to continue, or raise Max Tokens in its model preset.'
    )
    const silent = describeOutputLimitStop({ outputTokens: 65536, wroteReply: false })
    expect(silent).toBe(
      'The model reached its output limit of 65,536 tokens before it wrote a reply (its thinking counts toward the limit). Ask again, or raise Max Tokens in its model preset.'
    )
  })

  // A wording that the context-exhaustion classifier matched would auto-continue a stop that a
  // fresh run meets again (send-routed re-runs context exhaustion up to three times).
  it('is never read as context exhaustion', () => {
    for (const wroteReply of [true, false]) {
      for (const outputTokens of [65536, null]) {
        expect(isContextExhaustionError(describeOutputLimitStop({ outputTokens, wroteReply }))).toBe(false)
      }
    }
  })

  it('says "its output limit" when the count is unknown, never "0 tokens"', () => {
    for (const unknown of [null, undefined, 0, Number.NaN, -3]) {
      const text = describeOutputLimitStop({ outputTokens: unknown as number | null | undefined, wroteReply: true })
      expect(text.startsWith('The model reached its output limit before')).toBe(true)
      expect(text).not.toMatch(/\d/)
    }
  })

  it('carries the facts the banner, the compile note, and the recovery hold read', () => {
    const meta = outputLimitFailureMetadata('stopped', '2026-09-24T10:00:00.000Z')
    expect(meta).toEqual({
      response_failed: true,
      failure_kind: 'output_limit',
      error_message: 'stopped',
      error_code: 'MODEL_OUTPUT_LIMIT',
      failed_at: '2026-09-24T10:00:00.000Z',
    })
    expect(OUTPUT_LIMIT_FAILURE_KIND).toBe('output_limit')
    expect(OUTPUT_LIMIT_ERROR_CODE).toBe('MODEL_OUTPUT_LIMIT')
  })
})
