import type { LiveGoonBakeInput, LiveGoonBakeOutput, LiveGoonBakeStage } from './liveGoonBaker'
import {
  LIVE_GOON_BAKER_WORKER_CONTRACT,
  type LiveGoonBakerWorkerEvent,
  type LiveGoonBakerWorkerRequest
} from './liveGoonBaker.workerProtocol'

export type LiveGoonBakerClientOptions = {
  signal?: AbortSignal
  onProgress?: (stage: LiveGoonBakeStage) => void
}

function inputTransferList(input: LiveGoonBakeInput): Transferable[] {
  const buffers = [input.packageBytes.buffer, input.modelBytes.buffer, input.manifestBytes.buffer]
  if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) {
    throw new Error('Live Goon baker input bytes must use transferable ArrayBuffers.')
  }
  return Array.from(new Set(buffers)) as ArrayBuffer[]
}

/**
 * Run the deterministic baker off the UI thread. There is intentionally no
 * main-thread fallback: an unavailable worker is a visible build failure.
 */
export function bakeLiveGoonInWorker(
  input: LiveGoonBakeInput,
  options: LiveGoonBakerClientOptions = {}
): Promise<LiveGoonBakeOutput> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Live Goon bake was aborted.', 'AbortError'))
  }
  const worker = new Worker(new URL('./liveGoonBaker.worker.ts', import.meta.url), { type: 'module' })
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      worker.terminate()
      callback()
    }
    const abort = () => {
      finish(() => reject(new DOMException('Live Goon bake was aborted.', 'AbortError')))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('error', (event) => {
      finish(() => reject(new Error(event.message || 'Live Goon baker worker crashed.')))
    })
    worker.addEventListener('message', (message: MessageEvent<LiveGoonBakerWorkerEvent>) => {
      const event = message.data
      if (!event || event.contract !== LIVE_GOON_BAKER_WORKER_CONTRACT || event.id !== id) {
        finish(() => reject(new Error('Live Goon baker worker returned an invalid event envelope.')))
        return
      }
      if (event.kind === 'progress') {
        options.onProgress?.(event.stage)
        return
      }
      if (event.kind === 'failed') {
        finish(() => reject(new Error(event.message)))
        return
      }
      finish(() => resolve(event.output))
    })
    const request: LiveGoonBakerWorkerRequest = {
      contract: LIVE_GOON_BAKER_WORKER_CONTRACT,
      id,
      input
    }
    try {
      // These exact fetch buffers have no caller-side use after dispatch. Move
      // them into the Worker instead of cloning the full authoring package.
      worker.postMessage(request, inputTransferList(input))
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
