import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-106 DL-106-03: sends addressed to the retired `n8n` primary-agent type must fail
 * LOUDLY and with zero side effects.
 *
 * send-routed is ~8k lines and cannot be imported in a unit test, so this pins the
 * ordering and content of the guard against the file itself — the same approach
 * `send-routed-group-contract.test.ts` uses for the group-turn clip boundary.
 */
describe('send-routed retired primary-agent type guard', () => {
  it('rejects the retired type before any side effect can run', () => {
    const resolveType = source.indexOf(
      'const finalAgentType = normalizePrimaryAgentType(agent, agentType)',
    )
    const guard = source.indexOf("code: 'primary_agent_type_retired'", resolveType)
    // The turn lock is the first write-shaped call inside the POST handler itself.
    // (Clip consumption and the memory commit live in helper functions defined ABOVE
    // the handler, so their file offsets say nothing about call order — the guard's
    // position relative to the lock is what proves nothing has run yet.)
    const sessionTurn = source.indexOf('registerSessionTurn(', guard)

    expect(resolveType).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(resolveType)
    expect(sessionTurn).toBeGreaterThan(guard)
  })

  it('runs nothing between resolving the type and the guard', () => {
    const resolveType = source.indexOf(
      'const finalAgentType = normalizePrimaryAgentType(agent, agentType)',
    )
    const guardStart = source.indexOf(
      'if (\n      isN8nPrimaryAgentType(finalAgentType) ||',
      resolveType,
    )
    const between = source.slice(resolveType, guardStart)

    expect(guardStart).toBeGreaterThan(resolveType)
    // Only the comment block separates them; no await, no write.
    expect(between).not.toContain('await ')
  })

  it('checks the stored record as well as the client-supplied override', () => {
    // `agentType` arrives in the request body and OUTRANKS the stored record inside
    // normalizePrimaryAgentType, so checking only the resolved value would let a client
    // override its way past the guard on a retired agent.
    const guardBlock = source.slice(
      source.indexOf('if (\n      isN8nPrimaryAgentType(finalAgentType) ||'),
      source.indexOf("code: 'primary_agent_type_retired'"),
    )

    expect(guardBlock).toContain('isN8nPrimaryAgentType(finalAgentType)')
    expect(guardBlock).toContain('isN8nPrimaryAgentType(normalizePrimaryAgentType(agent))')
  })

  it('tells the user to delete the agent, since no type switcher exists', () => {
    const guard = source.indexOf("code: 'primary_agent_type_retired'")
    const details = source.slice(guard, source.indexOf('{ status: 409 }', guard))

    expect(details).toContain('Delete this agent')
    expect(details).toContain('API or CLI agent')
    // DL-106-01: the error must not imply n8n itself is gone.
    expect(details).toContain('n8n Workflow Subagents are unchanged')
  })

  it('has no n8n Primary send path left in the file', () => {
    expect(source).not.toContain('messageRouter')
    expect(source).not.toContain('registerN8nPrimaryRun')
    expect(source).not.toContain('rewriteBatshitCallbackUrlsForN8nRuntime')
    expect(source).not.toContain("code: 'n8n_primary_in_progress'")
  })

  it('keeps exactly the two surviving accepted-send boundaries', () => {
    const clipConsumeSites = source.split(
      'await consumePostCompileSessionClips(sessionId)',
    ).length - 1

    // API/CLI single send + group send. The third (n8n) site retired with the lane.
    expect(clipConsumeSites).toBe(2)
  })
})
