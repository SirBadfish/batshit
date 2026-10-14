/**
 * SA-117 P2 (DL-117-06) — the seam mints a run credential instead of handing over the
 * instance token.
 *
 * The suite this replaces asserted the three behaviours the seam used to have: prefer
 * `BATSHIT_TOKEN`, fall back to `MCP_GATEWAY_AUTH_TOKEN`, answer `null` when neither is set.
 * All three are gone on purpose — the fallback was a second name for the same instance
 * secret (DL-117-06), and "answer null" was the silent-fallback shape this story removes: a
 * run with no credential must fail, not start unauthenticated.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mintRunCredential } = vi.hoisted(() => ({ mintRunCredential: vi.fn() }))

vi.mock('$lib/server/services/agentRunCredentials', () => ({
  mintRunCredential
}))

import { mintCliRunCredential } from '../cliHelperToken'

describe('mintCliRunCredential', () => {
  beforeEach(() => {
    mintRunCredential.mockReset()
  })

  it('mints one credential for this run and returns the token exactly once', async () => {
    mintRunCredential.mockResolvedValue({
      credentialId: 'arc_abc',
      token: 'arc_abc.bsac_secret',
      record: { id: 'arc_abc', agentId: 'agent-1' }
    })

    await expect(
      mintCliRunCredential({
        userId: 'user-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        runtime: 'codex'
      })
    ).resolves.toEqual({
      credentialId: 'arc_abc',
      token: 'arc_abc.bsac_secret',
      agentId: 'agent-1'
    })

    expect(mintRunCredential).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      runtime: 'codex',
      // F-P2-1: an ordinary primary run is not delegated, so the store still requires an
      // `agent:` record for it.
      delegated: false,
      processOwner: null,
      commandParentAgentId: null,
      delegatedBashEnabled: false,
      // BL-75: and it names no separate skill scope; its own agent governs.
      scopeAgentId: null,
      // BL-81: nor a delegated control scope; its own settings govern what it may use.
      allowedControlIds: null,
      mcpGatewayScope: [],
      // BL-686: and no saved CLI tools unless the bridge names the run's list.
      cliToolScope: [],
      fetchZipAllowed: false,
      codexToolOutputTokenLimit: null
    })
  })

  it('returns the agent the record was minted for, so the bridge can revoke by it', async () => {
    // F-P1-5: a record the 24 h backstop already reaped cannot name its own agent's index,
    // so `revokeRunCredential` takes the hint from here.
    mintRunCredential.mockResolvedValue({
      credentialId: 'arc_def',
      token: 'arc_def.bsac_secret',
      record: { id: 'arc_def', agentId: 'agent-2' }
    })

    const minted = await mintCliRunCredential({
      userId: 'user-1',
      agentId: 'agent-2',
      sessionId: 'session-1',
      runtime: 'claude'
    })

    expect(minted.agentId).toBe('agent-2')
    expect(mintRunCredential).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: null, runtime: 'claude' })
    )
  })

  it('passes the delegated marker through for a Subagent or Worker run (F-P2-1)', async () => {
    mintRunCredential.mockResolvedValue({
      credentialId: 'arc_ghi',
      token: 'arc_ghi.bsac_secret',
      record: { id: 'arc_ghi', agentId: 'subagent_cli_worker_agent_1_1', delegated: true }
    })

    await mintCliRunCredential({
      userId: 'user-1',
      agentId: 'subagent_cli_worker_agent_1_1',
      sessionId: 'session-1',
      runtime: 'codex',
      delegated: true,
      processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-parent' },
      allowedControlIds: ['use.artifact.*']
    })

    expect(mintRunCredential).toHaveBeenCalledWith(
      // BL-81: the control scope rides to the record with the marker.
      expect.objectContaining({ delegated: true, allowedControlIds: ['use.artifact.*'],
        processOwner: { userId: 'user-1', kind: 'agent', id: 'agent-parent' } })
    )
  })

  it('passes no control scope for a primary run (BL-81)', async () => {
    mintRunCredential.mockResolvedValue({
      credentialId: 'arc_jkl',
      token: 'arc_jkl.bsac_secret',
      record: { id: 'arc_jkl', agentId: 'agent-1' }
    })

    await mintCliRunCredential({ userId: 'user-1', agentId: 'agent-1', sessionId: 'session-1', runtime: 'codex' })

    expect(mintRunCredential).toHaveBeenCalledWith(expect.objectContaining({ allowedControlIds: null }))
  })

  it('does not swallow a mint failure: a run that cannot prove who it is must not start', async () => {
    mintRunCredential.mockRejectedValue(new Error('Agent "ghost" was not found for this user'))

    await expect(
      mintCliRunCredential({
        userId: 'user-1',
        agentId: 'ghost',
        sessionId: 'session-1',
        runtime: 'codex'
      })
    ).rejects.toThrow(/was not found/)
  })

  it('forwards the server-resolved gateway snapshot including an explicit empty list', async () => {
    mintRunCredential.mockResolvedValue({
      credentialId: 'arc_scope', token: 'arc_scope.bsac_secret',
      record: { agentId: 'agent-1' }
    })
    for (const scope of [['gateway-a'], []]) {
      await mintCliRunCredential({
        userId: 'user-1', agentId: 'agent-1', sessionId: 'session-1',
        runtime: 'claude', mcpGatewayScope: scope
      })
      expect(mintRunCredential).toHaveBeenLastCalledWith(
        expect.objectContaining({ mcpGatewayScope: scope })
      )
    }
  })
})

/**
 * BL-81 — both bridges mint a delegated run's credential with the same three fields.
 *
 * The Codex bridge is driven end to end in `codexBridge.test.ts`; no suite drives
 * `ClaudeBridge.streamNativeMode` (SA-117 P2 review, F-P2-6), so this reads the two call sites
 * and holds them to one shape. `mintRunCredential` refuses a delegated mint without its control
 * scope, so a bridge that dropped it would fail every Subagent and Worker run at start; this
 * makes that omission red in CI before a run ever finds it.
 */
describe('the two bridges mint a delegated run the same way (BL-81)', () => {
  it('passes the delegated marker, the skill scope and the control scope on both lanes', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const mintCall = (file: string) => {
      const source = readFileSync(join(__dirname, '..', file), 'utf8')
      const start = source.indexOf('await mintCliRunCredential({')
      expect(start, file).toBeGreaterThan(-1)
      return source.slice(start, source.indexOf('})', start)).replace(/\s+/g, ' ')
    }
    for (const file of ['codexBridge.ts', 'claudeBridge.ts']) {
      const call = mintCall(file)
      expect(call, file).toContain('delegated: request.delegatedRun === true')
      expect(call, file).toContain('scopeAgentId: request.scopeAgentId ?? null')
      expect(call, file).toContain('allowedControlIds: request.delegatedAllowedControlIds ?? null')
      expect(call, file).toContain('mcpGatewayScope: request.selectedGateways ?? []')
      // BL-686: both bridges mint the run's saved CLI tools through the one shared rule.
      expect(call, file).toContain('cliToolScope: await resolveRunCredentialCliToolScope(request)')
    }
  })
})
