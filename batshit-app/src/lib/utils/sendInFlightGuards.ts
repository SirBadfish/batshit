export function hasInterruptibleActiveResponse(params: {
  activeStreamCount: number
  hasAbortController: boolean
}) {
  return params.activeStreamCount > 0 || params.hasAbortController
}

export function shouldBlockSendWhileInFlight(params: {
  sendInFlight: boolean
  hasInterruptibleActiveResponse: boolean
}) {
  return params.sendInFlight && !params.hasInterruptibleActiveResponse
}

export const INTERRUPTED_SEND_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

export function isSessionTurnInProgressPayload(payload: unknown) {
  return (
    payload != null &&
    typeof payload === 'object' &&
    (payload as Record<string, unknown>).code === 'session_turn_in_progress'
  )
}

export function shouldRetryInterruptedSendAfterSessionTurnInProgress(params: {
  wasInterrupting: boolean
  status: number
  payload: unknown
  attemptIndex: number
  maxAttempts: number
}) {
  return (
    params.wasInterrupting &&
    params.status === 409 &&
    params.attemptIndex < params.maxAttempts &&
    isSessionTurnInProgressPayload(params.payload)
  )
}

export function isLatestSendRun(params: {
  runId: number
  latestRunId: number
}) {
  return params.runId === params.latestRunId
}
