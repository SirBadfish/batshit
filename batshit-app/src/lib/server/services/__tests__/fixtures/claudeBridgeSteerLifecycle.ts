type Runner = { cleanup?: () => void | Promise<void> }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

export class ClosingClaudeFixtureError extends Error {
  constructor(readonly owner: ClaudeBridgeSteerLifecycle) {
    super('Cannot start work in a closing fixture')
  }
}

/** BL-1139: retain ownership until async setup, real bridge runners and pumps settle. */
export class ClaudeBridgeSteerLifecycle {
  private state: 'open' | 'closing' | 'closed' | 'failed' = 'open'
  private setups: Array<Promise<Outcome<Runner>>> = []
  private runners = new Set<Runner>()
  private children: Array<() => void> = []
  private pumps: Array<{ outcome: Promise<Outcome<unknown>>; expectedRejection: boolean }> = []
  private closing: Promise<void> | null = null

  get drained() { return this.state === 'closed' }

  assertOpen() {
    if (this.state !== 'open') throw new ClosingClaudeFixtureError(this)
  }

  ownChild(close: () => void) {
    this.assertOpen()
    this.children.push(close)
  }

  setup<T extends Runner>(start: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const pending = Promise.resolve().then(() => {
      this.assertOpen()
      return start()
    }).then((runner) => {
      this.runners.add(runner)
      // A returned runner is owned even if the test timed out before receiving it.
      this.assertOpen()
      return runner
    })
    this.setups.push(pending.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ))
    return pending
  }

  pump<T>(start: () => Promise<T>, expectedRejection = false): Promise<T> {
    this.assertOpen()
    const promise = start()
    this.pumps.push({ expectedRejection, outcome: promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    ) })
    return promise
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    // Synchronous fence: another case cannot acquire the mock while this awaits setup.
    this.state = 'closing'
    this.closing = this.drain()
    return this.closing
  }

  private async drain() {
    const errors: unknown[] = []
    let cleanupFailed = false
    for (const outcome of await Promise.all(this.setups)) {
      if (!outcome.ok && !(outcome.error instanceof ClosingClaudeFixtureError && outcome.error.owner === this)) {
        errors.push(outcome.error)
      }
    }
    // Deliver close before runner cleanup removes the bridge's captured close listener.
    for (const close of this.children) {
      try { close() } catch (error) { cleanupFailed = true; errors.push(error) }
    }
    for (const runner of this.runners) {
      try { await runner.cleanup?.() } catch (error) { cleanupFailed = true; errors.push(error) }
    }
    const pumps = await Promise.all(this.pumps.map((pump) => pump.outcome))
    for (let i = 0; i < pumps.length; i++) {
      const outcome = pumps[i]
      if (!outcome.ok && !this.pumps[i].expectedRejection) errors.push(outcome.error)
    }
    // Cleanup failure leaves the ownership fence in place. Hook timeout also cannot release it.
    this.state = cleanupFailed ? 'failed' : 'closed'
    if (errors.length) throw new AggregateError(errors, 'Claude fixture setup/pump/cleanup failed')
  }
}
