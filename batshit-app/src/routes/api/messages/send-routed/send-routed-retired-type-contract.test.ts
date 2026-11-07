import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')
const typeSource = readFileSync('src/lib/utils/primaryAgentType.ts', 'utf8')

/**
 * SA-106 DL-106-03, SA-139 R4 (D14): a send addressed to a retired Primary type (`n8n`, and since
 * R4 `cli`, the Claude Code CLI lane and the Codex CLI lane R1 removed) must fail LOUDLY and with
 * zero side effects.
 *
 * send-routed cannot be imported in a unit test, so this pins the ordering and content of the
 * ONE guard against the file itself — the same approach `send-routed-group-contract.test.ts`
 * uses for the group-turn clip boundary. The behaviour behind it is pinned live in
 * `send-routed-record-reread-handler.test.ts` (the real handler).
 */
describe('send-routed retired primary-agent type guard', () => {
  const resolveTypeLine = 'const finalAgentType = normalizePrimaryAgentType(agent, agentType)'
  const guardLine = 'const retired = retiredPrimaryAgentRefusal(agent, agentType)'

  it('rejects a retired type before any side effect can run', () => {
    const resolveType = source.indexOf(resolveTypeLine)
    const guard = source.indexOf(guardLine, resolveType)
    const refusal = source.indexOf('{ status: 409 }', guard)
    // The turn lock is the first write-shaped call inside the POST handler itself, and a send
    // that meets another turn waits in the chat's line first (`queueSessionTurn`). Clip
    // consumption and the memory commit live in the run above the handler, so their file
    // offsets say nothing about call order; the guard's position relative to the lock is what
    // proves nothing has run yet.
    const queuedTurn = source.indexOf('queueSessionTurn(sessionId, {', guard)
    const sessionTurn = source.indexOf('registerSessionTurn(', guard)

    expect(resolveType).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(resolveType)
    expect(refusal).toBeGreaterThan(guard)
    expect(queuedTurn).toBeGreaterThan(refusal)
    expect(sessionTurn).toBeGreaterThan(refusal)
    // One guard for every retired type: none of the older per-type guards is left.
    expect(source.split('retiredPrimaryAgentRefusal(agent, agentType)').length - 1).toBe(1)
    expect(source).not.toContain('isN8nPrimaryAgentType(')
    expect(source).not.toContain('codex_cli_retired')
    expect(source).not.toContain('retiredCliPrimaryRecord(')
  })

  it('runs nothing between resolving the type and the guard', () => {
    const resolveType = source.indexOf(resolveTypeLine)
    const guard = source.indexOf(guardLine, resolveType)
    const between = source.slice(resolveType, guard)

    expect(guard).toBeGreaterThan(resolveType)
    // Only the comment block separates them; no await, no write.
    expect(between).not.toContain('await ')
  })

  it('checks the stored record as well as the client-supplied override', () => {
    // `agentType` arrives in the request body and OUTRANKS the stored record inside
    // normalizePrimaryAgentType, so checking only the resolved value would let a client
    // override its way past the guard on a retired agent, and the request's type must be
    // checked too, so a request cannot ask for a retired type on a live agent.
    const guard = source.indexOf(guardLine)
    const block = source.slice(guard, source.indexOf('{ status: 409 }', guard))
    expect(block).toContain('if (retired) {')
    expect(block).toContain('{ error: retired.error, code: retired.code, details: retired.details }')

    const fn = typeSource.slice(
      typeSource.indexOf('export function retiredPrimaryAgentRefusal('),
      typeSource.indexOf('\n}', typeSource.indexOf('export function retiredPrimaryAgentRefusal(')),
    )
    expect(fn).toContain('const stored = normalizePrimaryAgentType(agent)')
    expect(fn).toContain('normalizePrimaryAgentType(agent, requestedType)')
    expect(fn).toContain('isRetiredPrimaryAgentType(stored)')
    expect(fn).toContain('isRetiredPrimaryAgentType(requested)')
    expect(fn).toContain('code: PRIMARY_AGENT_TYPE_RETIRED_CODE')
    expect(typeSource).toContain("export const PRIMARY_AGENT_TYPE_RETIRED_CODE = 'primary_agent_type_retired'")
    // Both retired types, through the one check.
    expect(typeSource).toContain('return isCliPrimaryAgentType(value) || isN8nPrimaryAgentType(value)')
  })

  it('refuses every later turn of the request again, before its compile and side effects', () => {
    // A queued, woken, resumed or continued turn and a group speaker all reach the run, which
    // refuses a retired record before discovery, the compile, the memory commit and the Clips.
    const runGuard = source.indexOf('const retiredPrimaryType = retiredPrimaryAgentRefusal(agent)')
    expect(runGuard).toBeGreaterThan(-1)
    expect(source.slice(runGuard, runGuard + 300)).toContain('retiredPrimaryType.code,\n      409,')
    const consumeClips = source.indexOf('await consumePostCompileSessionClips(sessionId)')
    const memoryCommit = source.indexOf('memoryTurnCommit = await commitMemoryTurnState({')
    expect(consumeClips).toBeGreaterThan(runGuard)
    expect(memoryCommit).toBeGreaterThan(runGuard)
  })

  it('tells the user to delete the agent, since no type switcher exists', () => {
    const builder = typeSource.slice(
      typeSource.indexOf('export function retiredPrimaryAgentTypeMessage('),
      typeSource.indexOf('export function retiredPrimaryAgentRefusal('),
    )
    // Every retired type's sentence says the agent can only be deleted.
    expect(builder.split('so it can only be deleted').length - 1).toBe(3)
    // DL-106-01: the n8n error must not imply n8n itself is gone.
    expect(builder).toContain('n8n tool workflows are unchanged')
    expect(builder).toContain('pick a Claude plan model')
  })

  it('has no n8n Primary send path left in the file', () => {
    expect(source).not.toContain('messageRouter')
    expect(source).not.toContain('registerN8nPrimaryRun')
    expect(source).not.toContain('rewriteBatshitCallbackUrlsForN8nRuntime')
    expect(source).not.toContain("code: 'n8n_primary_in_progress'")
  })

  it('keeps exactly the two surviving accepted-send boundaries', () => {
    const clipConsumeSites = source.split(
      'consumePostCompileSessionClips(sessionId',
    ).length - 1

    // API single send + group send (spent once per round, when the round has ended, for the
    // Clips its speakers compiled: BL-600). The third (n8n) site retired with the lane.
    expect(clipConsumeSites).toBe(2)
  })
})
