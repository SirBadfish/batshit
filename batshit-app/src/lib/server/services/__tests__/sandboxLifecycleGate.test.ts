import { describe, expect, it } from 'vitest'
import { createSandboxLifecycleGate } from '../sandboxLifecycleGate'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('sandboxLifecycleGate', () => {
  it('shares one in-flight ensure between concurrent callers for a name', async () => {
    const gate = createSandboxLifecycleGate()
    const started = deferred<string>()
    let runs = 0
    const ensure = () =>
      gate.ensure('sandbox-a', () => {
        runs += 1
        return started.promise
      })

    const callers = [ensure(), ensure(), ensure(), ensure()]
    await flush()
    expect(runs).toBe(1)

    started.resolve('ready')
    await expect(Promise.all(callers)).resolves.toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(runs).toBe(1)
  })

  it('keeps names independent', async () => {
    const gate = createSandboxLifecycleGate()
    let runs = 0
    const ensure = (name: string) =>
      gate.ensure(name, async () => {
        runs += 1
        return name
      })

    await expect(Promise.all([ensure('a'), ensure('b'), ensure('a')])).resolves.toEqual([
      'a',
      'b',
      'a'
    ])
    expect(runs).toBe(2)
  })

  it('runs a fresh ensure once the previous one settled', async () => {
    const gate = createSandboxLifecycleGate()
    let runs = 0
    const ensure = () =>
      gate.ensure('sandbox-a', async () => {
        runs += 1
        return runs
      })

    await expect(ensure()).resolves.toBe(1)
    await expect(ensure()).resolves.toBe(2)
  })

  it('hands a failed ensure to every caller that joined it, then lets the next call retry', async () => {
    const gate = createSandboxLifecycleGate()
    const started = deferred<string>()
    let runs = 0
    const ensure = (run: () => Promise<string>) =>
      gate.ensure('sandbox-a', () => {
        runs += 1
        return run()
      })

    const joined = [ensure(() => started.promise), ensure(() => started.promise)]
    started.reject(new Error('container system is not running'))
    for (const caller of joined) {
      await expect(caller).rejects.toThrow('container system is not running')
    }

    await expect(ensure(async () => 'ready')).resolves.toBe('ready')
    expect(runs).toBe(2)
  })

  it('starts an ensure that arrives during a removal only after the removal finished', async () => {
    const gate = createSandboxLifecycleGate()
    const removing = deferred()
    const order: string[] = []

    const removal = gate.remove('sandbox-a', async () => {
      order.push('remove:start')
      await removing.promise
      order.push('remove:end')
    })
    await flush()
    const ensure = gate.ensure('sandbox-a', async () => {
      order.push('ensure')
    })
    await flush()
    expect(order).toEqual(['remove:start'])

    removing.resolve()
    await Promise.all([removal, ensure])
    expect(order).toEqual(['remove:start', 'remove:end', 'ensure'])
  })

  it('does not let a caller join an ensure that has a removal queued behind it', async () => {
    const gate = createSandboxLifecycleGate()
    const creating = deferred()
    const order: string[] = []
    let runs = 0
    const ensure = (label: string) =>
      gate.ensure('sandbox-a', async () => {
        runs += 1
        order.push(`ensure:${label}`)
        if (runs === 1) await creating.promise
      })

    const first = ensure('first')
    const removal = gate.remove('sandbox-a', async () => {
      order.push('remove')
    })
    const late = ensure('late')
    creating.resolve()
    await Promise.all([first, removal, late])

    expect(runs).toBe(2)
    expect(order).toEqual(['ensure:first', 'remove', 'ensure:late'])
  })

  it('skips an idle-only removal while a lease is held, and removes after release', async () => {
    const gate = createSandboxLifecycleGate()
    let removals = 0
    const remove = () =>
      gate.removeIfIdle('sandbox-a', async () => {
        removals += 1
        return 'removed'
      })

    const release = gate.lease('sandbox-a')
    await expect(remove()).resolves.toEqual({ removed: false })
    expect(removals).toBe(0)

    release()
    release()
    await expect(remove()).resolves.toEqual({ removed: true, value: 'removed' })
    expect(removals).toBe(1)
  })

  it('runs a forced removal while leased, but only after an ensure already under way', async () => {
    const gate = createSandboxLifecycleGate()
    const creating = deferred()
    const order: string[] = []
    const release = gate.lease('sandbox-a')

    const ensure = gate.ensure('sandbox-a', async () => {
      order.push('ensure:start')
      await creating.promise
      order.push('ensure:end')
    })
    const removal = gate.remove('sandbox-a', async () => {
      order.push('remove')
    })
    await flush()
    expect(order).toEqual(['ensure:start'])

    creating.resolve()
    await Promise.all([ensure, removal])
    expect(order).toEqual(['ensure:start', 'ensure:end', 'remove'])
    release()
  })

  it('reports busy names and forgets a name once nothing uses it', async () => {
    const gate = createSandboxLifecycleGate()
    const creating = deferred()

    const release = gate.lease('sandbox-a')
    const ensure = gate.ensure('sandbox-b', () => creating.promise)
    expect(gate.isBusy('sandbox-a')).toBe(true)
    expect(gate.isBusy('sandbox-b')).toBe(true)
    expect(gate.isBusy('sandbox-c')).toBe(false)
    expect(gate.trackedNameCount()).toBe(2)

    release()
    creating.resolve()
    await ensure
    await gate.removeIfIdle('sandbox-c', async () => null)

    expect(gate.isBusy('sandbox-a')).toBe(false)
    expect(gate.isBusy('sandbox-b')).toBe(false)
    expect(gate.trackedNameCount()).toBe(0)
  })
})
