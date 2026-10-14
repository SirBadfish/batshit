import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'

import {
  ApprovalResumeReplayError,
  buildApprovalResumeReplay,
  buildReplayableTranscript,
  findPausedApprovalTurn,
  interleaveDeliveredSteers,
} from '../approvalResumeReplay'
import { buildSteerInjectionText, type DeliveredSteer } from '$lib/utils/steerControl'

/**
 * BL-322. Shapes are the ones the SA-072 P2 offline OCR chat stored (2026-09-25): the paused
 * reply ran `use.artifact.lighton_ocr` with the Clip id, got `app_offline`, then asked for
 * approval to start the app with `sys.pinokio.run`.
 */
const CLIP_ID = 'clip_1790382991162_15b5eeff_0'

const earlierCall: ModelMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'On it! Let me run it now!' },
    {
      type: 'tool-call',
      toolCallId: 'toolu_ocr',
      toolName: 'native_batshit_tool_use',
      input: { ref: 'artifact:use.artifact.lighton_ocr', input: { image: CLIP_ID } },
    },
  ],
} as ModelMessage
const earlierResult: ModelMessage = {
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: 'toolu_ocr',
      toolName: 'native_batshit_tool_use',
      output: { type: 'text', value: 'error: app_offline' },
    },
  ],
} as ModelMessage
const approvalStep: ModelMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: "LightOn OCR isn't running in Pinokio right now, I'll kick it off!" },
    {
      type: 'tool-call',
      toolCallId: 'toolu_start',
      toolName: 'native_batshit_tool_use',
      input: { ref: 'fabric:sys.pinokio.run', input: { appId: 'LightOnOCR-2-1B-Pinokio.git' } },
    },
    { type: 'tool-approval-request', approvalId: 'aitxt-approval-1', toolCallId: 'toolu_start' },
  ],
} as ModelMessage

const pausedRecord = {
  role: 'assistant',
  content: 'On it! {{batshit-zip:cool_tool_1:::Artifact Run}} Batshit will show you an Approve card.',
  metadata: {
    providerMessages: [earlierCall, earlierResult, approvalStep],
    providerMessageSource: {
      providerId: 'anthropic',
      connectionId: 'direct:anthropic',
      modelId: 'claude-sonnet-4-6',
    },
  },
}

const expected = { providerId: 'anthropic', connectionId: 'direct:anthropic' }

describe('findPausedApprovalTurn', () => {
  const history = [
    { id: 'u0', role: 'user', content: 'Earlier question', created_at: '2026-09-25T20:30:00.000Z' },
    { id: 'a0', role: 'assistant', content: 'Earlier answer' },
    {
      id: 'u1',
      role: 'user',
      content: 'Can you read this receipt with my LightOn OCR artifact?',
      created_at: '2026-09-25T20:36:35.000Z',
      metadata: { projectPath: '/Users/fixture/hello', fileReferences: [{ path: 'README.md' }] },
    },
    { id: 'a1', role: 'assistant', content: pausedRecord.content },
  ]

  it('compiles the paused turn: the history before its message, and that message as the current one', () => {
    const turn = findPausedApprovalTurn(history, 'a1')
    expect(turn).not.toBeNull()
    expect(turn!.history.map((message) => message.id)).toEqual(['u0', 'a0'])
    expect(turn!.currentMessage.id).toBe('u1')
    expect(turn!.currentText).toBe('Can you read this receipt with my LightOn OCR artifact?')
    expect(turn!.from).toBe('user')
    expect(turn!.at?.toISOString()).toBe('2026-09-25T20:36:35.000Z')
    expect(turn!.projectPath).toBe('/Users/fixture/hello')
    expect(turn!.fileReferences).toEqual([{ path: 'README.md' }])
  })

  it('never compiles what came after the paused reply', () => {
    const turn = findPausedApprovalTurn(
      [...history, { id: 'u2', role: 'user', content: 'a later message' }],
      'a1',
    )
    expect(turn!.history.map((message) => message.id)).toEqual(['u0', 'a0'])
    expect(turn!.currentMessage.id).toBe('u1')
  })

  it("compiles a woken turn's DM as the note it was", () => {
    const turn = findPausedApprovalTurn(
      [
        { id: 'u1', role: 'user', content: 'DM from Pip: check the build', metadata: { wake: { chainDepth: 1 } } },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      'a1',
    )
    expect(turn!.from).toBe('batshit')
  })

  it('refuses a history that does not hold the paused turn', () => {
    expect(findPausedApprovalTurn(history, 'missing')).toBeNull()
    expect(findPausedApprovalTurn(history, '')).toBeNull()
    expect(findPausedApprovalTurn([{ id: 'a1', role: 'assistant', content: 'x' }], 'a1')).toBeNull()
    expect(
      findPausedApprovalTurn(
        [
          { id: 'a0', role: 'assistant', content: 'another agent' },
          { id: 'a1', role: 'assistant', content: 'x' },
        ],
        'a1',
      ),
    ).toBeNull()
    expect(
      findPausedApprovalTurn(
        [
          { id: 'u1', role: 'user', content: '   ' },
          { id: 'a1', role: 'assistant', content: 'x' },
        ],
        'a1',
      ),
    ).toBeNull()
  })
})

describe('buildApprovalResumeReplay', () => {
  it('replays EVERY step the paused run took, not only the one that asked for approval', () => {
    const replay = buildApprovalResumeReplay({
      record: pausedRecord,
      approvalIds: ['aitxt-approval-1'],
      expected,
    })
    expect(replay).toEqual([earlierCall, earlierResult, approvalStep])
    // The earlier call's input is how the agent knows the Clip id it already used.
    expect(JSON.stringify(replay)).toContain(CLIP_ID)
  })

  it('drops a system message and a leading result with no call before it', () => {
    const replay = buildApprovalResumeReplay({
      record: {
        metadata: {
          ...pausedRecord.metadata,
          providerMessages: [
            { role: 'system', content: 'never replayed' },
            earlierResult,
            earlierCall,
            earlierResult,
            approvalStep,
          ],
        },
      },
      approvalIds: ['aitxt-approval-1'],
      expected,
    })
    expect(replay).toEqual([earlierCall, earlierResult, approvalStep])
  })

  it('allows a different id for the same model', () => {
    expect(() =>
      buildApprovalResumeReplay({
        record: {
          metadata: {
            ...pausedRecord.metadata,
            providerMessageSource: { ...pausedRecord.metadata.providerMessageSource, modelId: 'claude-sonnet-4-6-20260801' },
          },
        },
        approvalIds: ['aitxt-approval-1'],
        expected,
      }),
    ).not.toThrow()
  })

  it('refuses when the saved reply holds no request for the answered approval', () => {
    const attempt = () =>
      buildApprovalResumeReplay({ record: pausedRecord, approvalIds: ['another'], expected })
    expect(attempt).toThrow(ApprovalResumeReplayError)
    try {
      attempt()
    } catch (error) {
      expect((error as ApprovalResumeReplayError).code).toBe('APPROVAL_RESUME_CONTEXT_MISSING')
      expect((error as ApprovalResumeReplayError).status).toBe(409)
    }
    expect(() => buildApprovalResumeReplay({ record: null, approvalIds: ['aitxt-approval-1'], expected })).toThrow(
      ApprovalResumeReplayError,
    )
    expect(() => buildApprovalResumeReplay({ record: pausedRecord, approvalIds: [], expected })).toThrow(
      ApprovalResumeReplayError,
    )
  })

  it('refuses a reply another provider or connection wrote', () => {
    for (const other of [
      { providerId: 'openai', connectionId: 'direct:anthropic' },
      { providerId: 'anthropic', connectionId: 'openrouter' },
    ]) {
      try {
        buildApprovalResumeReplay({ record: pausedRecord, approvalIds: ['aitxt-approval-1'], expected: other })
        throw new Error('expected a refusal')
      } catch (error) {
        expect((error as ApprovalResumeReplayError).code).toBe('APPROVAL_RESUME_MODEL_CHANGED')
      }
    }
  })
})

function steer(step: number, text: string, overrides: Partial<DeliveredSteer> = {}): DeliveredSteer {
  return {
    steerId: `s_${step}_${text.length}`,
    messageId: 'a1',
    text,
    at: '2026-09-25T20:37:00.000Z',
    source: 'user',
    step,
    lane: 'api',
    ...overrides,
  }
}

describe('interleaveDeliveredSteers', () => {
  const step0 = [earlierCall, earlierResult]
  const step1 = [approvalStep]

  it('puts a steer back before the step the model read it at', () => {
    const delivered = steer(1, 'use the second page too')
    const messages = interleaveDeliveredSteers([...step0, ...step1], [2, 1], [delivered])
    expect(messages).toHaveLength(4)
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: buildSteerInjectionText([delivered]) }],
    })
    expect(messages[3]).toBe(approvalStep)
  })

  it("counts the approved results a resumed run starts with, and joins one step's steers into one message", () => {
    const approvedResult: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'toolu_start', toolName: 'native_batshit_tool_use', output: { type: 'text', value: 'ok' } }],
    } as ModelMessage
    const first = steer(1, 'first words')
    const second = steer(1, 'second words')
    const messages = interleaveDeliveredSteers([approvedResult, ...step0, ...step1], [2, 1], [first, second])
    expect(messages.map((message) => message.role)).toEqual(['tool', 'assistant', 'tool', 'user', 'assistant'])
    expect(messages[3]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: buildSteerInjectionText([first, second]) }],
    })
  })

  it('leaves out steers another lane delivered, and refuses counts that do not add up', () => {
    const messages = [...step0, ...step1]
    expect(interleaveDeliveredSteers(messages, [2, 1], [steer(1, 'codex', { lane: 'codex' })])).toEqual(messages)
    expect(() => interleaveDeliveredSteers(messages, [2, 5], [steer(1, 'x')])).toThrow()
  })
})

describe('buildReplayableTranscript', () => {
  it('stores what the SDK carried between steps, so a second card in the same reply replays the first run too', () => {
    const approvalResponse: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: 'aitxt-approval-1', approved: true }],
    } as ModelMessage
    const approvedResult: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'toolu_start', toolName: 'native_batshit_tool_use', output: { type: 'text', value: 'ok' } }],
    } as ModelMessage
    const nextAsk: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'toolu_run', toolName: 'native_bash_execute', input: { command: 'ls' } },
        { type: 'tool-approval-request', approvalId: 'aitxt-approval-2', toolCallId: 'toolu_run' },
      ],
    } as ModelMessage

    const stored = buildReplayableTranscript({
      replay: [earlierCall, earlierResult, approvalStep],
      approvalResponse,
      responseMessages: [approvedResult, nextAsk],
      stepMessageCounts: [1],
      steers: [],
    })
    expect(stored).toEqual([earlierCall, earlierResult, approvalStep, approvalResponse, approvedResult, nextAsk])

    // The second click replays all of it.
    const replay = buildApprovalResumeReplay({
      record: { metadata: { ...pausedRecord.metadata, providerMessages: stored } },
      approvalIds: ['aitxt-approval-2'],
      expected,
    })
    expect(replay).toEqual(stored)
  })
})
