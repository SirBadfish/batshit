import { describe, expect, it } from 'vitest'
import { createApprovalResumeStart, composeInPlaceResumeMessage } from '$lib/server/services/approvalResumeMessage'
import { readApprovalResumeStart, isNewApprovalResume, approvalResumeStartPatch } from './approvalResumeStream'
import { buildEndStreamingContent } from '$lib/server/services/sseEndContentBuilder'

describe('approval continuation stream', () => {
  const first = { zipId: 'cool_tool_1789786818581_first', reference: '{{batshit-zip:cool_tool_1789786818581_first:::First tool}}' }
  const next = { zipId: 'cool_tool_1789786818582_next', reference: '{{batshit-zip:cool_tool_1789786818582_next:::Next tool}}' }
  const prior = {
    content: `Before approval.\n\n${first.reference}`,
    metadata: { zipIds: [first.zipId], zipReferences: [first], providerMessages: ['large private continuation'], toolApprovals: { approvals: [{ approvalId: 'first', status: 'approved' }] } },
    intermediateSteps: [{ toolCallId: 'first' }]
  }

  it('reopens a completed message once and seeds its existing words and trusted tools', () => {
    const resume = createApprovalResumeStart(prior, 100)
    expect(readApprovalResumeStart({ approvalResume: resume })).toEqual(resume)
    expect(resume.prior.metadata).not.toHaveProperty('providerMessages')
    expect(isNewApprovalResume(prior.metadata, resume)).toBe(true)
    const started = approvalResumeStartPatch(resume, { approvalResume: resume, steerable: true })
    expect(started.status).toBe('in_progress')
    expect(started.content).toBe(`${prior.content}\n\n`)
    expect(started.metadata.zipIds).toEqual([first.zipId])
    expect(started.metadata).not.toHaveProperty('approvalResume')
    expect(isNewApprovalResume(started.metadata, resume)).toBe(false)
    const later = createApprovalResumeStart({ ...prior, metadata: started.metadata }, 99)
    expect(later.version).toBe(101)
    expect(isNewApprovalResume(started.metadata, later)).toBe(true)
    expect(isNewApprovalResume({ approvalResumeVersion: 101 }, resume)).toBe(false)
  })

  it('gives the live end and persisted resume identical text, tool order and trust', () => {
    const events = [
      { type: 'chunk', content: 'Resumed.' },
      { type: 'tool-call', toolCallId: 'next', order: 1 },
      { type: 'tool-result', toolCallId: 'next', order: 1, zipReferences: [next] },
      { type: 'chunk', content: 'Finished.' }
    ]
    const resumed = buildEndStreamingContent({ streamEvents: events, inlineCapable: true, toolZipRefs: [next], allZipRefs: [next] }).content
    const live = buildEndStreamingContent({ streamEvents: events, inlineCapable: true, toolZipRefs: [next], allZipRefs: [first, next], priorContent: prior.content }).content
    const saved = composeInPlaceResumeMessage(prior, { content: resumed, metadata: { zipIds: [next.zipId], zipReferences: [next], toolApprovals: { approvals: [{ approvalId: 'second', status: 'pending' }] } } })
    expect(live).toBe(saved.content)
    expect(live.indexOf(first.reference)).toBeLessThan(live.indexOf('Resumed.'))
    expect(live.indexOf('Resumed.')).toBeLessThan(live.indexOf(next.reference))
    expect(live.indexOf(next.reference)).toBeLessThan(live.indexOf('Finished.'))
    expect(saved.metadata.zipIds).toEqual([first.zipId, next.zipId])
    expect(saved.metadata.toolApprovals.approvals[0].approvalId).toBe('second')
  })

  it('rejects missing or malformed start envelopes', () => {
    for (const value of [undefined, {}, { approvalResume: true }, { approvalResume: { version: NaN, prior } }, { approvalResume: { version: 10 } }]) {
      expect(readApprovalResumeStart(value)).toBeNull()
    }
  })
})
