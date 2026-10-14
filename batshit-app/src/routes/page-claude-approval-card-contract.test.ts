import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')

/**
 * BL-636 / BL-496 — the chat page's side of a Claude approval card. The rules live in
 * `$lib/utils/claudeApprovalCard.ts`, where `claudeApprovalCard.test.ts` drives them with the
 * helper's real event order; `+page.svelte` is 8,000 lines, so these pins hold only that the
 * page's two handlers ASK those rules.
 */
describe('the chat page and a Claude approval card', () => {
  it('the tool_start / tool-call handler makes or completes the card only through the rule', () => {
    const start = page.indexOf("} else if (data.type === 'tool_start' || data.type === 'tool-call') {")
    const end = page.indexOf("} else if (data.type === 'tool-result') {", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const branch = page.slice(start, end)
    expect(branch).toContain(
      '\n        const nextApprovals = applyClaudeApprovalCardEvent(\n          Array.isArray(existingSummary?.approvals) ? existingSummary.approvals : [],\n          data,\n'
    )
    expect(branch).toContain('\n        if (nextApprovals) {\n')
    expect(branch).not.toContain('alreadyTracked')
  })

  it('the tool-result handler ends the card through the rule, which knows an expiry', () => {
    expect(page).toContain(
      '\n          const nextApprovals = settleClaudeApprovalCard(approvals, details.approvalId, data, approved)\n'
    )
  })
})
