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
      delegated: false
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
      delegated: true
    })

    expect(mintRunCredential).toHaveBeenCalledWith(
      expect.objectContaining({ delegated: true })
    )
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
})
