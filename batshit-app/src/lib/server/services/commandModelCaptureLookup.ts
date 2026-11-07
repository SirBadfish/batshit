import { getCommandModelCapture, type CommandModelCapture } from './commandModelCapture'

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
