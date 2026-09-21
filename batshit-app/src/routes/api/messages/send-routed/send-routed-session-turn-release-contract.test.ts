import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A request's end-of-turn work belongs to the lock IT registered (2026-09-18).
 *
 * The rules live in `streamAbortRegistry.ts`, where they are tested: a lock is an orphan
 * only after two quiet minutes, a request releases its own registration and never a later
 * one, and `isSessionTurnHeldByAnother` says when another turn has the chat. These pins are
 * about the wiring: the POST keeps its registration's id, releases by it, and runs the
 * run-end sandbox sweep only while no other turn holds the chat. Measured live before the
 * fix (`_local/lock-prune-proof/`): the old request's sweep killed a newer turn's approved
 * command, and its release by message id deleted that turn's lock.
 */
describe('send-routed: the request releases only the turn it registered', () => {
  const register = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n')
  const refused = source.indexOf('\n\t    if (!sessionTurnRegistration.ok) {\n', register)
  const keepId = source.indexOf(
    '\n    const sessionTurnId = sessionTurnRegistration.entry.turnId\n',
    refused
  )
  const outerFinally = source.indexOf('\n    } finally {\n', keepId)

  it('keeps its registration’s id straight after the registration succeeds', () => {
    expect(register).toBeGreaterThan(-1)
    expect(refused).toBeGreaterThan(register)
    expect(keepId).toBeGreaterThan(refused)
    // Nothing else runs between the refusal branch and taking the id.
    expect(source.slice(refused, keepId)).not.toContain('await ')
  })

  it('runs the run-end sandbox sweep only while no other turn holds the chat', () => {
    const tail = source.slice(outerFinally, outerFinally + 2_000)
    expect(tail).toContain(
      '\n      if (!isSessionTurnHeldByAnother(sessionId, sessionTurnId)) {\n        try {\n          const sandboxCleanupWarnings =\n            await nativeToolService.cleanupExecutionSandboxesForSession(sessionId)\n'
    )
  })

  it('releases by its own registration, never by message id', () => {
    const tail = source.slice(outerFinally)
    expect(tail).toContain('\n\t      releaseSessionTurn(sessionId, sessionTurnId)\n')
    expect(source).not.toContain('clearSessionTurn(')
    expect(source.split('releaseSessionTurn(').length - 1).toBe(1)
  })
})
