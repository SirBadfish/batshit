import { describe, expect, it } from 'vitest'
import { sealFileReadProof, sealLiveFileReadReplay, verifyFileReadProofSeal, verifyLiveFileReadReplaySeal } from '../fileReadProofSeal'

/**
 * SA-137: only a proof this process sealed can make a `fileReadSource`. A proof that went through
 * JSON (the SDK's step output, an SSE event) still verifies; any change to it, or a proof posted
 * without the seal (BL-2002), does not.
 */

const unsealed = {
  version: 1 as const,
  userId: 'user-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  messageId: 'reply-1',
  toolCallId: 'call-1',
  backend: 'local' as const,
  workspaceRoot: '/work/project',
  rootIdentity: '1:2',
  cwd: '/work/project',
  reads: [{ part: null, file: 'a.js', locator: 'a.js', view: { kind: 'whole' as const, numbering: 'none' as const } }]
}

describe('fileReadProofSeal (SA-137)', () => {
  it('verifies a sealed proof, also after a JSON round trip and with its keys in another order', () => {
    const sealed = sealFileReadProof(unsealed)
    expect(verifyFileReadProofSeal(sealed)).toBe(true)
    expect(verifyFileReadProofSeal(JSON.parse(JSON.stringify(sealed)))).toBe(true)
    const { reads, ...rest } = sealed
    expect(verifyFileReadProofSeal({ reads, ...rest })).toBe(true)
  })

  it('refuses a changed proof, a missing or malformed seal, and anything that is not a proof', () => {
    const sealed = sealFileReadProof(unsealed)
    expect(verifyFileReadProofSeal({ ...sealed, sessionId: 'session-2' })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [{ ...sealed.reads[0], locator: '.env' }] })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, extra: 'x' })).toBe(false)
    expect(verifyFileReadProofSeal({ ...unsealed })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, seal: 'A'.repeat(43) })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, seal: sealed.seal + '=' })).toBe(false)
    expect(verifyFileReadProofSeal(null)).toBe(false)
    expect(verifyFileReadProofSeal([sealed])).toBe(false)
  })

  it('checks the shape before any work, so a deeply nested outside value is refused, not walked', () => {
    let deep: any = {}
    for (let level = 0; level < 100_000; level += 1) deep = { next: deep }
    const sealed = sealFileReadProof(unsealed)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [{ ...sealed.reads[0], view: deep }] })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: deep })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [], userId: deep })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [{ ...sealed.reads[0], file: deep }] })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, cwd: 'x'.repeat(64 * 1024 * 1024) })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [{ ...sealed.reads[0], part: -1 }] })).toBe(false)
    expect(verifyFileReadProofSeal({ ...sealed, reads: [{ ...sealed.reads[0], locator: '../a.js' }] })).toBe(false)
  })

  it.each([true, false])('seals the actual Apple backend and setting bit %s, and rejects either field being changed', (liveReadsOn) => {
    const apple = sealFileReadProof({
      ...unsealed,
      backend: 'apple_container',
      liveReadsOn,
      reads: [{ ...unsealed.reads[0], view: { kind: 'typed', startLine: 1, endLine: null } }]
    })
    expect(verifyFileReadProofSeal(apple)).toBe(true)
    expect(verifyFileReadProofSeal(JSON.parse(JSON.stringify(apple)))).toBe(true)
    expect(verifyFileReadProofSeal({ ...apple, backend: 'local' })).toBe(false)
    expect(verifyFileReadProofSeal({ ...apple, liveReadsOn: !liveReadsOn })).toBe(false)
    const { liveReadsOn: _bit, ...missingBit } = apple
    expect(verifyFileReadProofSeal(missingBit)).toBe(false)
    expect(verifyFileReadProofSeal({ ...apple, backend: 'docker_sandbox' })).toBe(false)

    // Both altered fields are valid shapes; a Local seal still cannot become an Apple seal.
    const local = sealFileReadProof({ ...unsealed, liveReadsOn })
    expect(verifyFileReadProofSeal({ ...local, backend: 'apple_container' })).toBe(false)
  })
})

describe('the two seals are separate domains', () => {
  it('a proof seal never verifies as a replay seal, and the reverse', () => {
    const proof = sealFileReadProof(unsealed as any)
    expect(verifyLiveFileReadReplaySeal(proof as any)).toBe(false)
    const replay = sealLiveFileReadReplay({ ...(unsealed as any) })
    expect(replay.seal).not.toBe(proof.seal)
    expect(verifyFileReadProofSeal(replay)).toBe(false)
  })
})
