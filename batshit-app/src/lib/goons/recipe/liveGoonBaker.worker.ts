/// <reference lib="webworker" />

import { bakeLiveGoon } from './liveGoonBaker'
import {
  LIVE_GOON_BAKER_WORKER_CONTRACT,
  type LiveGoonBakerWorkerEvent,
  type LiveGoonBakerWorkerRequest
} from './liveGoonBaker.workerProtocol'

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

function post(event: LiveGoonBakerWorkerEvent, transfer: Transferable[] = []) {
  scope.postMessage(event, transfer)
}

scope.addEventListener('message', (message: MessageEvent<LiveGoonBakerWorkerRequest>) => {
  const request = message.data
  if (
    !request ||
    request.contract !== LIVE_GOON_BAKER_WORKER_CONTRACT ||
    typeof request.id !== 'string' ||
    request.id.length === 0
  ) {
    throw new Error('Live Goon baker worker received an invalid request envelope.')
  }
  void bakeLiveGoon(request.input, (stage) => {
    post({ contract: LIVE_GOON_BAKER_WORKER_CONTRACT, id: request.id, kind: 'progress', stage })
  })
    .then((output) => {
      post(
        { contract: LIVE_GOON_BAKER_WORKER_CONTRACT, id: request.id, kind: 'complete', output },
        [output.modelBytes.buffer, output.manifestBytes.buffer, output.packageBytes.buffer]
      )
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      post({ contract: LIVE_GOON_BAKER_WORKER_CONTRACT, id: request.id, kind: 'failed', message })
    })
})
