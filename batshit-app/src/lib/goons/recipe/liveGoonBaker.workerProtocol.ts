import type {
  LiveGoonBakeInput,
  LiveGoonBakeOutput,
  LiveGoonBakeStage
} from './liveGoonBaker'

export const LIVE_GOON_BAKER_WORKER_CONTRACT = 'goon-live-baker-worker/v1' as const

export type LiveGoonBakerWorkerRequest = {
  contract: typeof LIVE_GOON_BAKER_WORKER_CONTRACT
  id: string
  input: LiveGoonBakeInput
}

export type LiveGoonBakerWorkerEvent =
  | {
      contract: typeof LIVE_GOON_BAKER_WORKER_CONTRACT
      id: string
      kind: 'progress'
      stage: LiveGoonBakeStage
    }
  | {
      contract: typeof LIVE_GOON_BAKER_WORKER_CONTRACT
      id: string
      kind: 'complete'
      output: LiveGoonBakeOutput
    }
  | {
      contract: typeof LIVE_GOON_BAKER_WORKER_CONTRACT
      id: string
      kind: 'failed'
      message: string
    }
