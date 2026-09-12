import { describe, expect, it } from 'vitest'
import {
  analyzeApprovalState,
  buildApprovalHistoryMessages,
  buildControlApprovalEntry,
  readControlApprovalRequestFromToolResult,
  resolveApprovalSummarySource,
  toolResultApprovalRendersCard,
  TOOL_APPROVAL_TIMEOUT_MS,
  type ApprovalHistoryMessage
} from '../toolApprovalState'

/**
 * SA-116 F-P2-3 — a card that waits for a resume turn must not be swept.
 *
 * The three-minute clock exists because an API-lane card is holding a paused SDK stream
 * open. A CLI-lane card holds nothing: the managed agent's refusal already came back and
 * the turn already ended, so it is answered by a LATER turn and its record lives 24 hours.
 * Sweeping it would mark the entry `expired` and retire its record while the card the user
 * is looking at still says "Waits for you".
 */

const REQUESTED_AT = '2026-09-10T12:00:00.000Z'
const REQUESTED_AT_MS = Date.parse(REQUESTED_AT)
const FIVE_MINUTES_LATER = REQUESTED_AT_MS + 5 * 60_000

function messageWith(entry: Record<string, any>): ApprovalHistoryMessage[] {
  return [
    {
      id: 'msg_assistant_1',
      created_at: REQUESTED_AT,
      metadata: {
        toolApprovals: {
          mode: 'all',
          approvals: [entry]
        }
      }
    }
  ]
}

const pendingEntry = (control?: Record<string, any>) => ({
  approvalId: 'aitxt-1',
  status: 'pending',
  requestedAt: REQUESTED_AT,
  toolName: 'native_batshit_tool_use',
  ...(control ? { control } : {})
})

describe('analyzeApprovalState — the three-minute sweep', () => {
  it('expires a Bash approval, which carries no control block at all', () => {
    const snapshot = analyzeApprovalState(
      messageWith({
        approvalId: 'aitxt-bash',
        status: 'pending',
        requestedAt: REQUESTED_AT,
        toolName: 'native_bash_execute'
      }),
      FIVE_MINUTES_LATER
    )

    expect(snapshot.byId.get('aitxt-bash')?.status).toBe('expired')
    expect(snapshot.newlyExpired).toHaveLength(1)
    expect(snapshot.updates).toHaveLength(1)
  })

  it('expires an api-lane control card, and names its record so the sweep can retire it', () => {
    const snapshot = analyzeApprovalState(
      messageWith(
        pendingEntry({
          approvalId: 'apr_api_record',
          controlId: 'sys.memory.delete',
          controlTitle: 'Memory Delete',
          riskLevel: 'confirm',
          lane: 'api'
        })
      ),
      FIVE_MINUTES_LATER
    )

    expect(snapshot.byId.get('aitxt-1')?.status).toBe('expired')
    expect(snapshot.newlyExpired[0]?.controlApprovalId).toBe('apr_api_record')
  })

  it('leaves a cli-lane control card pending five minutes on, with no record to retire', () => {
    const snapshot = analyzeApprovalState(
      messageWith(
        pendingEntry({
          approvalId: 'apr_cli_record',
          controlId: 'sys.skill.import',
          controlTitle: 'Skill Import',
          riskLevel: 'confirm',
          lane: 'cli'
        })
      ),
      FIVE_MINUTES_LATER
    )

    expect(snapshot.byId.get('aitxt-1')?.status).toBe('pending')
    expect(snapshot.byId.get('aitxt-1')?.expiresAtMs).toBeNull()
    expect(snapshot.newlyExpired).toHaveLength(0)
    expect(snapshot.updates).toHaveLength(0)
  })

  it('leaves a service-lane control card pending too', () => {
    const snapshot = analyzeApprovalState(
      messageWith(
        pendingEntry({
          approvalId: 'apr_service_record',
          controlId: 'sys.runtime_addon.start',
          controlTitle: 'Runtime Addon Start',
          riskLevel: 'confirm',
          lane: 'service'
        })
      ),
      FIVE_MINUTES_LATER
    )

    expect(snapshot.byId.get('aitxt-1')?.status).toBe('pending')
    expect(snapshot.newlyExpired).toHaveLength(0)
  })

  it('ignores an expiresAt a cli entry somehow carries, rather than honouring it', () => {
    // Defence against a stale entry written before this rule, or a client-shaped payload:
    // the lane decides, not a timestamp that may have come from anywhere.
    const snapshot = analyzeApprovalState(
      messageWith({
        ...pendingEntry({
          approvalId: 'apr_cli_record',
          controlId: 'sys.skill.import',
          controlTitle: 'Skill Import',
          riskLevel: 'confirm',
          lane: 'cli'
        }),
        expiresAt: new Date(REQUESTED_AT_MS + TOOL_APPROVAL_TIMEOUT_MS).toISOString()
      }),
      FIVE_MINUTES_LATER
    )

    expect(snapshot.byId.get('aitxt-1')?.status).toBe('pending')
    expect(snapshot.newlyExpired).toHaveLength(0)
  })

  it('still expires an api-lane card one millisecond past its deadline', () => {
    const snapshot = analyzeApprovalState(
      messageWith(
        pendingEntry({
          approvalId: 'apr_api_record',
          controlId: 'sys.memory.delete',
          controlTitle: 'Memory Delete',
          riskLevel: 'confirm',
          lane: 'api'
        })
      ),
      REQUESTED_AT_MS + TOOL_APPROVAL_TIMEOUT_MS
    )

    expect(snapshot.byId.get('aitxt-1')?.status).toBe('expired')
  })
})

describe('buildApprovalHistoryMessages', () => {
  it('prefers the persisted copy of a message that already carries approvals', () => {
    const persisted = [
      {
        id: 'msg_1',
        created_at: REQUESTED_AT,
        metadata: { toolApprovals: { mode: 'all', approvals: [pendingEntry()] } }
      }
    ]
    const fromRequest = [{ id: 'msg_1', created_at: REQUESTED_AT, metadata: {} }]

    const combined = buildApprovalHistoryMessages(fromRequest, persisted)
    expect(combined).toHaveLength(1)
    expect(combined[0]?.metadata?.toolApprovals?.approvals).toHaveLength(1)
  })

  it('takes the request copy when the persisted one has no approvals yet', () => {
    const persisted = [{ id: 'msg_1', created_at: REQUESTED_AT, metadata: {} }]
    const fromRequest = [
      {
        id: 'msg_1',
        created_at: REQUESTED_AT,
        metadata: { toolApprovals: { mode: 'all', approvals: [pendingEntry()] } }
      }
    ]

    const combined = buildApprovalHistoryMessages(fromRequest, persisted)
    expect(combined[0]?.metadata?.toolApprovals?.approvals).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * SA-116 DL-116-07 — the card that arrives as a tool RESULT
 * ------------------------------------------------------------------ */

const APPROVAL_REQUEST = {
  approvalId: 'apr_cli_record_1',
  controlId: 'sys.skill.import',
  controlTitle: 'Skill Import',
  riskLevel: 'confirm',
  input: { source: 'https://example.com/skill.zip' },
  inputSummary: { source: 'https://example.com/skill.zip' },
  lane: 'cli',
  requestedAt: REQUESTED_AT
}

describe('readControlApprovalRequestFromToolResult', () => {
  it("reads the block /api/controls/use lifts to the top of its 403", () => {
    const request = readControlApprovalRequestFromToolResult({
      success: false,
      controlId: 'sys.skill.import',
      error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL', message: 'paused' },
      approvalRequest: APPROVAL_REQUEST
    })
    expect(request?.approvalId).toBe('apr_cli_record_1')
    expect(request?.lane).toBe('cli')
    // F-P2-4: the exact bytes travel, so the CLI card shows what the API card shows.
    expect(request?.input).toEqual({ source: 'https://example.com/skill.zip' })
  })

  it('reads it from error.details too, which is where useControl puts it', () => {
    const request = readControlApprovalRequestFromToolResult({
      success: false,
      error: {
        code: 'CONTROL_RISK_REQUIRES_APPROVAL',
        details: { approvalRequest: APPROVAL_REQUEST }
      }
    })
    expect(request?.approvalId).toBe('apr_cli_record_1')
  })

  it('reads it off a cli: broker result, where executeCliTool returns it', () => {
    const request = readControlApprovalRequestFromToolResult({
      success: false,
      toolId: 'confirm_echo',
      code: 'REQUIRES_APPROVAL',
      requiresApproval: true,
      approvalRequest: { ...APPROVAL_REQUEST, controlId: 'cli_tool:confirm_echo' },
      ref: 'cli:confirm_echo',
      family: 'cli'
    })
    expect(request?.controlId).toBe('cli_tool:confirm_echo')
  })

  it('reads it out of the raw MCP envelope a managed CLI helper answers with', () => {
    // Measured on BSMS: a Codex turn's tool result arrives as
    // `{ content: [{ type: 'text', text: '<the json>' }], structured_content, input }`.
    // `normalizeToolResult` only unwraps that when the envelope IS the array, so the body
    // is still a STRING here — the first live run found no card for exactly this reason.
    const request = readControlApprovalRequestFromToolResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            auth: 'service',
            success: false,
            controlId: 'sys.schedule.create',
            error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL' },
            approvalRequest: { ...APPROVAL_REQUEST, controlId: 'sys.schedule.create' }
          })
        }
      ],
      structured_content: null,
      input: { ref: 'fabric:sys.schedule.create' }
    })
    expect(request?.approvalId).toBe('apr_cli_record_1')
    expect(request?.controlId).toBe('sys.schedule.create')
    expect(request?.input).toEqual({ source: 'https://example.com/skill.zip' })
  })

  it('leaves ordinary MCP text alone rather than parsing every tool result', () => {
    const text = JSON.stringify({ results: [{ ref: 'fabric:sys.schedule.create' }] })
    expect(
      readControlApprovalRequestFromToolResult({ content: [{ type: 'text', text }] })
    ).toBeNull()
  })

  it('survives text that mentions approvalRequest but is not JSON', () => {
    expect(
      readControlApprovalRequestFromToolResult({
        content: [{ type: 'text', text: 'the "approvalRequest" field was truncated…' }]
      })
    ).toBeNull()
  })

  it('refuses an id that is not an apr_ record id — nothing here may invent a record', () => {
    expect(
      readControlApprovalRequestFromToolResult({
        approvalRequest: { ...APPROVAL_REQUEST, approvalId: 'aitxt-not-a-record' }
      })
    ).toBeNull()
    expect(
      readControlApprovalRequestFromToolResult({
        approvalRequest: { ...APPROVAL_REQUEST, approvalId: 'apr_../../etc/passwd' }
      })
    ).toBeNull()
  })

  it('refuses a block with no control id or an unknown risk level', () => {
    expect(
      readControlApprovalRequestFromToolResult({
        approvalRequest: { ...APPROVAL_REQUEST, controlId: '' }
      })
    ).toBeNull()
    expect(
      readControlApprovalRequestFromToolResult({
        approvalRequest: { ...APPROVAL_REQUEST, riskLevel: 'safe' }
      })
    ).toBeNull()
  })

  it('answers null for an ordinary tool result', () => {
    expect(readControlApprovalRequestFromToolResult({ success: true, output: 'fine' })).toBeNull()
    expect(readControlApprovalRequestFromToolResult('just text')).toBeNull()
    expect(readControlApprovalRequestFromToolResult(null)).toBeNull()
  })
})

describe('buildControlApprovalEntry', () => {
  it('builds a fabric card entry with no three-minute clock', () => {
    const entry = buildControlApprovalEntry({
      request: readControlApprovalRequestFromToolResult({
        approvalRequest: APPROVAL_REQUEST
      })!,
      toolCallId: 'call_1',
      toolName: 'mcp__batshit_gateway_x__batshit_tool_use'
    })

    expect(entry.approvalId).toBe('apr_cli_record_1')
    expect(entry.status).toBe('pending')
    expect(entry.source).toBe('fabric')
    expect(entry.expiresAt).toBeUndefined()
    expect(entry.control?.controlTitle).toBe('Skill Import')
    expect(entry.control?.lane).toBe('cli')
    expect(entry.control?.input).toEqual({ source: 'https://example.com/skill.zip' })
    expect((entry.toolCall as any)?.toolCallId).toBe('call_1')
  })

  it('and the sweep leaves that entry alone', () => {
    const entry = buildControlApprovalEntry({
      request: readControlApprovalRequestFromToolResult({
        approvalRequest: APPROVAL_REQUEST
      })!
    })
    const snapshot = analyzeApprovalState(messageWith(entry as any), FIVE_MINUTES_LATER)
    expect(snapshot.byId.get('apr_cli_record_1')?.status).toBe('pending')
  })
})

describe('toolResultApprovalRendersCard', () => {
  it('F-P3-1: refuses an api-lane block — the in-place SDK resume cannot answer it', () => {
    // `useControl` and `executeCliTool` answer `lane: 'api'` for a mode3 call, so this is
    // the policy-let-it-through, gate-paused-it case. A card here would be clicked into
    // the SDK resume with an id the SDK never issued, and `ai@7.0.77` throws for the
    // whole click — a real SDK card answered at the same time fails with it.
    const api = readControlApprovalRequestFromToolResult({
      approvalRequest: { ...APPROVAL_REQUEST, lane: 'api' }
    })!
    expect(toolResultApprovalRendersCard(api)).toBe(false)
  })

  it('cards a cli-lane and a service-lane block, which a resume turn answers', () => {
    const cli = readControlApprovalRequestFromToolResult({ approvalRequest: APPROVAL_REQUEST })!
    const service = readControlApprovalRequestFromToolResult({
      approvalRequest: { ...APPROVAL_REQUEST, lane: 'service' }
    })!
    expect(toolResultApprovalRendersCard(cli)).toBe(true)
    expect(toolResultApprovalRendersCard(service)).toBe(true)
  })
})

describe('resolveApprovalSummarySource', () => {
  it('says fabric only when every card in the turn is a control pause', () => {
    const fabric = { approvalId: 'a', status: 'pending' as const, source: 'fabric' as const }
    const sdk = { approvalId: 'b', status: 'pending' as const, source: 'vercel' as const }
    expect(resolveApprovalSummarySource([fabric])).toBe('fabric')
    expect(resolveApprovalSummarySource([fabric, sdk])).toBe('vercel')
    expect(resolveApprovalSummarySource([])).toBe('vercel')
  })
})
