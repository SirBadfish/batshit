import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-139 R4 retired the managed CLI Primary, and with it the CLI finish write (BL-503, BL-1361),
 * the Batshit-measured tool-window timing its performance strip fell back to (BL-1358), and the
 * helper's accounting-only Batshit runs (BL-1362). The API lane's failure evidence is pinned in
 * `send-routed-failed-run-evidence-contract.test.ts`. What stays here is BL-610's rule for the
 * one result case, pinned from the line start so a disabling prefix breaks it.
 */
describe('send-routed: every tool result goes through the whole result path (BL-610)', () => {
  it('skips no `dynamic` result', () => {
    const resultCase = source.indexOf("\n        case 'tool-error':\n        case 'tool-result': {\n")
    expect(resultCase).toBeGreaterThan(-1)
    const resultCaseEnd = source.indexOf("\n        case 'raw': {", resultCase)
    expect(resultCaseEnd).toBeGreaterThan(resultCase)
    // BL-610: the case skips no `dynamic` result (an API Subagent or workflow tool), so a dynamic
    // call goes through the whole result path like any other.
    const resultCaseBody = source.slice(resultCase, resultCaseEnd)
    expect(resultCaseBody).not.toContain('.dynamic')
  })
})
