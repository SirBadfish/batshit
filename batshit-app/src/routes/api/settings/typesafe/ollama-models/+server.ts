import { json, type RequestHandler } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { listOllamaDecisionModels } from '$lib/server/services/typesafe/ollamaDecisionModels'
import { normalizeJudgeBaseUrl } from '$lib/utils/judgeProviders'

/**
 * SA-120 P10a (DL-120-18) — the Ollama judge's model list on the Admin Judge Juice card: the models this Ollama
 * server reports with the `decision` capability, each with the `num_ctx` Ollama gives it when it says. The server
 * reads Ollama (`/api/tags`, `/api/show`), because a browser often cannot reach an Ollama on another computer.
 * Admin only; the address is checked like a saved judge's. Reads Ollama's model list only; no text is sent.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireAdmin(locals)
  if (!user.ok) return user.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const baseUrl = normalizeJudgeBaseUrl((body as { baseUrl?: unknown } | null)?.baseUrl)
  if (!baseUrl) {
    return json({ error: 'The address must be an http or https URL without a user name, query, or #.' }, { status: 400 })
  }
  const list = await listOllamaDecisionModels(baseUrl)
  if (!list.ok) return json({ error: list.error }, { status: 502 })
  return json({ baseUrl, models: list.models, otherModelCount: list.otherModelCount })
}
