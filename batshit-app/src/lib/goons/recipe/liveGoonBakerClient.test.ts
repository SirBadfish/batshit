import { afterEach, describe, expect, it, vi } from 'vitest'

import { bakeLiveGoonInWorker } from './liveGoonBakerClient'
import { LIVE_GOON_BAKER_WORKER_CONTRACT } from './liveGoonBaker.workerProtocol'
import type { LiveGoonBakeInput } from './liveGoonBaker'

class TransferProbeWorker {
  static latest: TransferProbeWorker | null = null
  static behavior: 'failed' | 'hang' | 'invalid' | 'crash' | 'complete' = 'failed'

  readonly terminate = vi.fn()
  readonly transfers: Transferable[][] = []
  private listeners = new Map<string, Array<(event: any) => void>>()

  constructor() {
    TransferProbeWorker.latest = this
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  postMessage(request: { id: string }, transfer: Transferable[] = []) {
    this.transfers.push(transfer)
    structuredClone(request, { transfer })
    if (TransferProbeWorker.behavior === 'hang') return
    queueMicrotask(() => {
      if (TransferProbeWorker.behavior === 'crash') {
        for (const listener of this.listeners.get('error') ?? []) {
          listener({ message: 'Injected Worker crash.' })
        }
        return
      }
      const emitMessage = (data: unknown) => {
        for (const listener of this.listeners.get('message') ?? []) listener({ data })
      }
      if (TransferProbeWorker.behavior === 'invalid') {
        emitMessage({ contract: 'wrong-contract', id: request.id, kind: 'complete' })
        return
      }
      if (TransferProbeWorker.behavior === 'complete') {
        emitMessage({
          contract: LIVE_GOON_BAKER_WORKER_CONTRACT,
          id: request.id,
          kind: 'progress',
          stage: 'validating-source'
        })
        emitMessage({
          contract: LIVE_GOON_BAKER_WORKER_CONTRACT,
          id: request.id,
          kind: 'complete',
          output: {
            contract: 'goon-live-bake-output/v1',
            packageBytes: new Uint8Array([1]),
            modelBytes: new Uint8Array([2]),
            manifestBytes: new Uint8Array([3])
          }
        })
        return
      }
      emitMessage(
        {
          data: {
            contract: LIVE_GOON_BAKER_WORKER_CONTRACT,
            id: request.id,
            kind: 'failed',
            message: 'Transfer probe complete.'
          }
        }.data
      )
    })
  }
}

function inputBytes(): LiveGoonBakeInput {
  return {
    packageBytes: new Uint8Array([1, 2, 3]),
    modelBytes: new Uint8Array([4, 5, 6, 7]),
    manifestBytes: new Uint8Array([8, 9])
  } as LiveGoonBakeInput
}

afterEach(() => {
  vi.unstubAllGlobals()
  TransferProbeWorker.latest = null
  TransferProbeWorker.behavior = 'failed'
})

describe('Live Goon baker Worker client', () => {
  it('moves all three authoring buffers into the Worker instead of cloning them', async () => {
    vi.stubGlobal('Worker', TransferProbeWorker)
    const input = inputBytes()

    const result = bakeLiveGoonInWorker(input)

    expect(TransferProbeWorker.latest?.transfers).toHaveLength(1)
    expect(TransferProbeWorker.latest?.transfers[0]).toHaveLength(3)
    expect(input.packageBytes.byteLength).toBe(0)
    expect(input.modelBytes.byteLength).toBe(0)
    expect(input.manifestBytes.byteLength).toBe(0)
    await expect(result).rejects.toThrow('Transfer probe complete.')
    expect(TransferProbeWorker.latest?.terminate).toHaveBeenCalledOnce()
  })

  it('forwards progress, resolves completion, and terminates the Worker', async () => {
    vi.stubGlobal('Worker', TransferProbeWorker)
    TransferProbeWorker.behavior = 'complete'
    const onProgress = vi.fn()

    const output = await bakeLiveGoonInWorker(inputBytes(), { onProgress })

    expect(onProgress).toHaveBeenCalledWith('validating-source')
    expect(output.contract).toBe('goon-live-bake-output/v1')
    expect(TransferProbeWorker.latest?.terminate).toHaveBeenCalledOnce()
  })

  it('fails and terminates on malformed Worker events', async () => {
    vi.stubGlobal('Worker', TransferProbeWorker)
    TransferProbeWorker.behavior = 'invalid'

    await expect(bakeLiveGoonInWorker(inputBytes())).rejects.toThrow('invalid event envelope')
    expect(TransferProbeWorker.latest?.terminate).toHaveBeenCalledOnce()
  })

  it('fails and terminates when the Worker crashes', async () => {
    vi.stubGlobal('Worker', TransferProbeWorker)
    TransferProbeWorker.behavior = 'crash'

    await expect(bakeLiveGoonInWorker(inputBytes())).rejects.toThrow('Injected Worker crash.')
    expect(TransferProbeWorker.latest?.terminate).toHaveBeenCalledOnce()
  })

  it('aborts a running bake and terminates the Worker', async () => {
    vi.stubGlobal('Worker', TransferProbeWorker)
    TransferProbeWorker.behavior = 'hang'
    const controller = new AbortController()
    const result = bakeLiveGoonInWorker(inputBytes(), { signal: controller.signal })

    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(TransferProbeWorker.latest?.terminate).toHaveBeenCalledOnce()
  })
})
