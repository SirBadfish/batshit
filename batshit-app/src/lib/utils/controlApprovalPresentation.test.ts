import { describe, expect, it } from 'vitest'
import {
  describeControlApproval,
  formatControlApprovalRiskWord,
  formatControlApprovalTitle,
  buildControlApprovalPauseGuidance,
  resolveApprovalSubmitSource
} from './controlApprovalPresentation'

/**
 * SA-116 P2 (DL-116-06) — the card's words, pinned against the entry shape a live run
 * produces.
 *
 * The fixture below is the shape P0 measured on BSMS (Part 2.10 (a)): the SDK's own
 * `aitxt-…` approval id, `toolName: 'native_batshit_tool_use'`, the model's raw broker
 * arguments under `toolCall.input` as `{ ref, input }`, and — added by P2 — the server's
 * `control` block. That nesting is the reason a hand-written flat fixture would pass while
 * the real card stayed blank.
 */

const liveEntry = (control: Record<string, any>, input: Record<string, any>) => ({
  approvalId: 'aitxt-3f2a',
  status: 'pending' as const,
  requestedAt: '2026-09-10T04:00:00.000Z',
  expiresAt: '2026-09-10T04:03:00.000Z',
  toolName: 'native_batshit_tool_use',
  toolCall: {
    type: 'tool-call',
    toolCallId: 'toolu_013Y',
    toolName: 'native_batshit_tool_use',
    input: { ref: `fabric:${control.controlId}`, input }
  },
  input: { ref: `fabric:${control.controlId}`, input },
  source: 'vercel' as const,
  control
})

describe('formatControlApprovalTitle', () => {
  it('names the control, not the broker tool', () => {
    // The measured P0 card read "Dynamic Tool Use" — the broker's display name — with the
    // control visible only inside the raw input.
    expect(
      formatControlApprovalTitle({
        approvalId: 'apr_1',
        controlId: 'sys.memory.delete',
        controlTitle: 'Delete Memory',
        riskLevel: 'confirm'
      })
    ).toBe('Memory Delete')
  })

  it('falls back to the tool title for a CLI tool, which has no Fabric control id', () => {
    expect(
      formatControlApprovalTitle({
        approvalId: 'apr_1',
        controlId: 'cli_tool:repo_snapshot',
        controlTitle: 'Repo Snapshot',
        riskLevel: 'restricted'
      })
    ).toBe('Repo Snapshot')
  })
})

describe('describeControlApproval', () => {
  it('reads a value out of the nested broker input a live entry carries', () => {
    const entry = liveEntry(
      {
        approvalId: 'apr_1',
        controlId: 'sys.memory.delete',
        controlTitle: 'Delete Memory',
        riskLevel: 'confirm'
      },
      { memory_id: 'mem_sa116' }
    )
    expect(describeControlApproval(entry)).toBe('delete memory mem_sa116')
  })

  it('F-P2-2: reads the exact payload before the shortened summary', () => {
    // A value longer than the summary's 240-character cap is cut there with a note. The
    // card and its one-line description must show what will actually run.
    const source = `https://example.test/skills/${'x'.repeat(300)}`
    const entry = liveEntry(
      {
        approvalId: 'apr_1',
        controlId: 'sys.skill.import',
        controlTitle: 'Import Skill',
        riskLevel: 'restricted',
        input: { source },
        inputSummary: { source: `${source.slice(0, 240)}… (${source.length} characters)` }
      },
      { source }
    )
    expect(describeControlApproval(entry)).toBe(`install skill from ${source}`)
  })

  it('prefers the server inputSummary, which is what the card shows', () => {
    const entry = liveEntry(
      {
        approvalId: 'apr_1',
        controlId: 'sys.skill.import',
        controlTitle: 'Import Skill',
        riskLevel: 'restricted',
        inputSummary: { source: 'https://github.com/example/skill' }
      },
      { source: 'https://github.com/example/skill' }
    )
    expect(describeControlApproval(entry)).toBe(
      'install skill from https://github.com/example/skill'
    )
  })

  it.each([
    [
      { controlId: 'sys.runtime_addon.start', controlTitle: 'Start Runtime Add-on' },
      { addonId: 'cloudflared' },
      'start Docker add-on cloudflared'
    ],
    [
      { controlId: 'sys.runtime_addon.stop', controlTitle: 'Stop Runtime Add-on' },
      { addonId: 'cloudflared' },
      'stop Docker add-on cloudflared'
    ],
    [
      { controlId: 'sys.artifact.rollback', controlTitle: 'Roll Back Artifact' },
      { artifactId: 'artifact_123', targetVersion: 4 },
      'roll artifact artifact_123 back to v4'
    ],
    [
      { controlId: 'sys.artifact.delete_version', controlTitle: 'Delete Artifact Version' },
      { artifactId: 'artifact_123', version: 2 },
      'delete version 2 of artifact artifact_123'
    ],
    [
      { controlId: 'cli_tool:repo_snapshot', controlTitle: 'Repo Snapshot' },
      { path: '/tmp' },
      'run CLI tool Repo Snapshot'
    ],
    [
      { controlId: 'sys.cli_tool.delete', controlTitle: 'Delete CLI Tool' },
      { toolId: 'repo_snapshot' },
      'cli tool delete repo_snapshot'
    ]
  ])('says what %o authorises', (control, input, expected) => {
    const entry = liveEntry(
      { approvalId: 'apr_1', riskLevel: 'confirm', ...control },
      input as Record<string, any>
    )
    expect(describeControlApproval(entry)).toBe(expected)
  })

  it('still says something useful when the input is missing', () => {
    expect(
      describeControlApproval({
        control: {
          approvalId: 'apr_1',
          controlId: 'sys.memory.delete',
          controlTitle: 'Delete Memory',
          riskLevel: 'confirm'
        }
      })
    ).toBe('delete a memory')
  })

  it('falls back to "run <title>" for a control with no summariser of its own', () => {
    expect(
      describeControlApproval({
        control: {
          approvalId: 'apr_1',
          controlId: 'sys.schedule.delete',
          controlTitle: 'Delete Schedule',
          riskLevel: 'confirm'
        }
      })
    ).toBe('run Schedule Delete')
  })
})

describe('formatControlApprovalRiskWord', () => {
  it('says the word, which is the whole of DL-116-11', () => {
    expect(formatControlApprovalRiskWord('restricted')).toBe('Restricted')
    expect(formatControlApprovalRiskWord('confirm')).toBe('Confirm')
  })
})

describe('resolveApprovalSubmitSource', () => {
  it("uses the entry's own source, even when the summary says claude", () => {
    // A managed Claude turn stamps the whole summary `claude` the moment any Bash approval
    // appears. A control card in that same turn must still go to send-routed.
    expect(
      resolveApprovalSubmitSource({ approvalId: 'a', source: 'fabric' } as any, 'claude')
    ).toBe('fabric')
    expect(
      resolveApprovalSubmitSource({ approvalId: 'a', source: 'vercel' } as any, 'claude')
    ).toBe('vercel')
  })

  it('still routes a Bash approval to the Claude bridge', () => {
    expect(
      resolveApprovalSubmitSource({ approvalId: 'a', source: 'claude' } as any, 'claude')
    ).toBe('claude')
  })

  it('falls back to the summary for an entry that names no source', () => {
    expect(resolveApprovalSubmitSource({ approvalId: 'a' } as any, 'claude')).toBe('claude')
    expect(resolveApprovalSubmitSource(null, 'vercel')).toBe('vercel')
    expect(resolveApprovalSubmitSource(null, null)).toBe('')
  })
})

/**
 * SA-116 P4 (DL-116-13) — the wording the MODEL reads when a control pauses.
 *
 * One builder, three lanes, because "do not retry it yourself" is true on exactly one of
 * them and actively harmful on another.
 */
describe('buildControlApprovalPauseGuidance', () => {
  const joined = (options: Record<string, any>) =>
    buildControlApprovalPauseGuidance(options).join('\n')

  it('never teaches the flag on any lane', () => {
    for (const lane of ['api', 'cli', 'service', '', null]) {
      const text = joined({ lane, controlTitle: 'Skill Import', approvalId: 'apr_1' })
      expect(text).toContain('Never pass allowRisky — it is ignored.')
      expect(text).not.toContain('allowRisky: true')
      expect(text).not.toContain('allowRisky=true')
    }
  })

  it('tells an API-lane model NOT to retry, and that no button exists for THIS call', () => {
    // F-P4-1 (Faye, P4 review): on the API lane the SDK pauses a risky call before it runs
    // and the model sees no tool result, so the only time it reads this text is the F-P3-1
    // path — the gate paused a call the policy let through — where no card is raised.
    // Promising "when the user clicks Approve" there is the P2-EVIDENCE §6 defect again.
    const text = joined({ lane: 'api', controlTitle: 'Memory Delete', approvalId: 'apr_1' })
    expect(text).toContain('Do not retry it yourself.')
    expect(text).toContain('no Approve button could be shown for this call')
    expect(text).toContain('asks for it again')
    expect(text).not.toContain('this same call runs with the same input')
  })

  it('tells a CLI-lane model that its OWN retry after the resume is what runs it', () => {
    const text = joined({ lane: 'cli', controlTitle: 'Skill Import', approvalId: 'apr_1' })
    // The opposite of the API lane: a managed Codex/Claude call cannot be un-paused, so
    // the resume turn hands the retry back to the model. "Do not retry it yourself" here
    // would strand the approval the user just granted.
    expect(text).not.toContain('Do not retry it yourself.')
    expect(text).toContain('you are resumed with an approval message')
    expect(text).toContain('retry the same ref with the same input')
  })

  it('admits, on the service lane, that there is no Approve button for this call', () => {
    const text = joined({ lane: 'service', controlTitle: 'Skill Import', approvalId: 'apr_1' })
    // P2-EVIDENCE §6: it used to claim the user had been asked to approve, when a call
    // with no chat message has nowhere to render a card at all.
    expect(text).not.toContain('asked the user to approve it')
    expect(text).toContain('no chat to show an Approve button in')
    expect(text).toContain('normal chat with this agent')
  })

  it('names the control and the approval id, and copes when it has neither', () => {
    expect(joined({ lane: 'api', controlTitle: 'Skill Import', approvalId: 'apr_9' })).toContain(
      `Batshit paused "Skill Import" for the user's approval (approval apr_9)`
    )
    const bare = joined({ lane: 'api' })
    expect(bare).toContain('this action')
    expect(bare).not.toContain('(approval')
  })
})
