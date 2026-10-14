import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { resolveAgentDeleteChatCountOutcome } from '../agentDeleteChatCount'

describe('resolveAgentDeleteChatCountOutcome (BL-778)', () => {
  it('is ok with a well-shaped body on a successful response', () => {
    const outcome = resolveAgentDeleteChatCountOutcome(
      { ok: true },
      { deletable: 3, infinite: 1, keptLocked: 0, archived: 2 }
    )
    expect(outcome).toEqual({
      status: 'ok',
      counts: { deletable: 3, infinite: 1, keptLocked: 0, archived: 2 }
    })
  })

  it('is ok with all-zero counts (a real "no chats" answer)', () => {
    const outcome = resolveAgentDeleteChatCountOutcome(
      { ok: true },
      { deletable: 0, infinite: 0, keptLocked: 0, archived: 0 }
    )
    expect(outcome).toEqual({
      status: 'ok',
      counts: { deletable: 0, infinite: 0, keptLocked: 0, archived: 0 }
    })
  })

  it('fails on a non-ok response, whatever the body says', () => {
    expect(
      resolveAgentDeleteChatCountOutcome(
        { ok: false },
        { deletable: 0, infinite: 0, keptLocked: 0, archived: 0 }
      )
    ).toEqual({ status: 'failed' })
  })

  it('fails when the fetch itself threw (no response at all)', () => {
    expect(resolveAgentDeleteChatCountOutcome(null, null)).toEqual({ status: 'failed' })
  })

  it('fails on an ok response with a malformed body -- never read as "zero chats"', () => {
    expect(resolveAgentDeleteChatCountOutcome({ ok: true }, null)).toEqual({ status: 'failed' })
    expect(resolveAgentDeleteChatCountOutcome({ ok: true }, {})).toEqual({ status: 'failed' })
    expect(resolveAgentDeleteChatCountOutcome({ ok: true }, { deletable: 'three' })).toEqual({
      status: 'failed'
    })
    expect(
      resolveAgentDeleteChatCountOutcome(
        { ok: true },
        { deletable: 1, infinite: -1, keptLocked: 0, archived: 0 }
      )
    ).toEqual({ status: 'failed' })
    expect(resolveAgentDeleteChatCountOutcome({ ok: true }, 'not an object')).toEqual({
      status: 'failed'
    })
  })

  it('BL-778 part 2: fails when archived is missing -- an old server answer is not "no archived chats"', () => {
    expect(
      resolveAgentDeleteChatCountOutcome({ ok: true }, { deletable: 1, infinite: 0, keptLocked: 0 })
    ).toEqual({ status: 'failed' })
    expect(
      resolveAgentDeleteChatCountOutcome(
        { ok: true },
        { deletable: 1, infinite: 0, keptLocked: 0, archived: 'two' }
      )
    ).toEqual({ status: 'failed' })
  })
})

// The panel is 15,000+ lines; pin that the delete flow actually refuses on a failed count
// instead of falling through to the plain dialog, and that it delegates to this tested
// function rather than reimplementing the shape check inline.
describe('BL-778: Agent Settings refuses the delete on a failed chat count', () => {
  const panel = readFileSync(
    'src/lib/components/settings/panels/AgentSettingsPanel.svelte',
    'utf8'
  )

  it('imports the shared resolver', () => {
    expect(panel).toContain(
      'import {\n    resolveAgentDeleteChatCountOutcome,\n    type AgentChatCounts,\n  } from "$lib/utils/agentDeleteChatCount";'
    )
  })

  it('handleDeletePrimaryAgent delegates to it and returns before any confirm dialog on failure', () => {
    const start = panel.indexOf('async function handleDeletePrimaryAgent')
    expect(start).toBeGreaterThan(0)
    const region = panel.slice(start, panel.indexOf("\n  async function handleDeleteSubagent", start))
    expect(region).toContain('resolveAgentDeleteChatCountOutcome(countResponse, body)')

    const failedIdx = region.indexOf('if (chatCountFailed)')
    const toastIdx = region.indexOf('toast.error(')
    const returnIdx = region.indexOf('return;', failedIdx)
    const firstDialogIdx = region.indexOf('confirmDialogWithCheckbox(')
    expect(failedIdx).toBeGreaterThan(0)
    expect(toastIdx).toBeGreaterThan(failedIdx)
    expect(returnIdx).toBeGreaterThan(toastIdx)
    // The refusal (toast + return) must come before either confirm dialog is ever built.
    expect(returnIdx).toBeLessThan(firstDialogIdx)
  })

  it('BL-778 part 2: the checkbox label names how many chats are archived', () => {
    const start = panel.indexOf('async function handleDeletePrimaryAgent')
    const region = panel.slice(start, panel.indexOf("\n  async function handleDeleteSubagent", start))
    expect(region).toContain(
      'chatCounts.archived > 0 ? `, ${chatCounts.archived} of them archived` : ""'
    )
    expect(region).toContain(
      'label: `Also delete its ${chatCounts.deletable} ${chatWord}${infiniteNote}${archivedNote}`'
    )
  })
})
