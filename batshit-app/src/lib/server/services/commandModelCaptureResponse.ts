import { json } from '@sveltejs/kit'
import { getCommandModelCapture, type CommandModelCapture } from './commandModelCapture'
import { TOOL_RESULT_TOO_LARGE_TOKENS } from '$lib/utils/toolResultSizeGuard'

/** Follow only Batshit's known result envelopes; arbitrary data fields are not capabilities. */
export function findCommandModelCapture(value: unknown, depth = 0): CommandModelCapture | null {
  if (!value || typeof value !== 'object' || depth > 4) return null
  const direct = getCommandModelCapture(value)
  if (direct) return direct
  for (const key of ['data', 'result', 'output', 'execution'] as const) {
    const nested = findCommandModelCapture((value as Record<string, unknown>)[key], depth + 1)
    if (nested) return nested
  }
  return null
}

/** Only authenticated managed helpers get the transport envelope; it is never a tool result. */
export function commandModelCaptureResponse(result: unknown, agentRun: boolean, status = 200, headers: Record<string, string> = {}): Response {
  const capture = agentRun ? findCommandModelCapture(result) : null
  if (!capture || Math.ceil(capture.originalTextChars / 4) < TOOL_RESULT_TOO_LARGE_TOKENS) {
    return json(result, { status, headers })
  }
  return json({ result, modelCapture: capture }, {
    status,
    headers: { ...headers, 'x-batshit-command-model-capture': '1' }
  })
}
