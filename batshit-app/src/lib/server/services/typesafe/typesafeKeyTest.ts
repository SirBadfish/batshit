import { getTypesafeClient } from './typesafeClient'
import { getTypesafeConfig } from './typesafeConfig'
import { describeTypesafeReason } from '$lib/utils/jevJuice'

/**
 * SA-120 P0, moved in the P7 review (Josh, 2026-09-17): the TypeSafe key's Test button lives
 * in Settings → API Keys with every other key, so this is the one real key test Batshit has.
 * Called only by `routes/api/settings/api-keys/test`, never by `apiKeyService`: that service is
 * reachable from the Fabric risk gate's modules, which must never reach the Jev client.
 * ONE fixed sample question, so the user can check the key and the model before turning
 * anything on. It deliberately ignores the master switch, because the user clicked it, and
 * the state is a constant: no chat text is ever sent from here.
 */
const SAMPLE_STATE = { message: 'The build passed and every test is green.' } as const
const SAMPLE_QUESTIONS = {
  good_news: {
    type: 'noul',
    instructions: 'Does `message` report good news?',
    criteria: { true: 'Success, progress, or relief', false: 'Failure, a problem, or nothing happened' }
  }
} as const
const TEST_DEADLINE_MS = 10_000

export type TypesafeKeyTestResult =
  | { ok: true; model: string; latencyMs: number; message: string }
  | { ok: false; error: string; reason: string; detail: string | null; latencyMs: number }

/** Ask Jev the fixed sample question with this key. Never throws; a failure is a described result. */
export async function testTypesafeKey(apiKey: string): Promise<TypesafeKeyTestResult> {
  const config = await getTypesafeConfig()
  const outcome = await getTypesafeClient().systemOne({
    apiKey,
    model: config.modelId,
    state: SAMPLE_STATE,
    questions: SAMPLE_QUESTIONS,
    attemptTimeoutMs: config.attemptTimeoutMs,
    deadlineMs: TEST_DEADLINE_MS
  })
  if (outcome.status !== 'ok') {
    const message = describeTypesafeReason(outcome.reason)
    const detail = outcome.detail ?? null
    return { ok: false, error: detail ? `${message} (${detail})` : message, reason: outcome.reason, detail, latencyMs: outcome.latencyMs }
  }
  return {
    ok: true,
    model: outcome.response.model,
    latencyMs: outcome.latencyMs,
    message: `${outcome.response.model} answered in ${outcome.latencyMs} ms.`
  }
}
