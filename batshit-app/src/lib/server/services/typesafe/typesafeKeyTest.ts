import type { JudgeProvider } from '$lib/types/typesafe'
import { builtinTypesafeProvider, judgeModelName, judgePrivacyClass, judgeServiceName, judgeWhereText } from '$lib/utils/judgeProviders'
import { describeTypesafeReason } from '$lib/utils/jevJuice'
import { buildJudgeEndpoint } from './judgeProviderEndpoint'
import { createTypesafeClient, getTypesafeClient, type TypesafeFetch } from './typesafeClient'
import { getTypesafeConfig } from './typesafeConfig'

/**
 * SA-120 P0, moved in the P7 review (Josh, 2026-09-17): the TypeSafe key's Test button lives
 * in Settings → API Keys with every other key, so this is the one real key test Batshit has.
 * Called only by `routes/api/settings/api-keys/test`, never by `apiKeyService`: that service is
 * reachable from the Fabric risk gate's modules, which must never reach the Jev client.
 * ONE fixed sample question, so the user can check the key and the model before turning
 * anything on. It deliberately ignores the master switch, because the user clicked it, and
 * the state is a constant: no chat text is ever sent from here.
 *
 * SA-120 P10a (DL-120-18): the same sample question tests any judge (`testJudgeProvider`), for the
 * Test button beside each judge on the Admin Judge Juice card (`POST /api/settings/typesafe/test`).
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
/**
 * A local judge may have to load its model first (Clef Flash through Ollama: about 10 s cold on Josh's Mac,
 * measured 2026-10-12), so its Test waits longer than a cloud judge's.
 */
const LOCAL_TEST_DEADLINE_MS = 30_000

export type TypesafeKeyTestResult =
  | { ok: true; model: string; latencyMs: number; message: string }
  | { ok: false; error: string; reason: string; detail: string | null; latencyMs: number }

/**
 * Ask one judge the fixed sample question. `apiKey` is `null` for a judge that takes none. Never throws; a failure
 * is a described result that names who serves the judge.
 */
export async function testJudgeProvider(
  provider: JudgeProvider,
  apiKey: string | null,
  options: { fetch?: TypesafeFetch } = {}
): Promise<TypesafeKeyTestResult> {
  const config = await getTypesafeConfig()
  const endpoint = buildJudgeEndpoint(provider)
  const client = options.fetch
    ? createTypesafeClient({ baseUrl: endpoint.baseUrl, path: endpoint.path, fetch: options.fetch, dispatcher: null })
    : getTypesafeClient(endpoint)
  // A judge on this computer or the local network may still be loading its model; a hosted one gets the usual wait (N4).
  const local = judgePrivacyClass(provider) !== 'cloud'
  const outcome = await client.systemOne({
    apiKey,
    model: provider.modelId,
    state: SAMPLE_STATE,
    questions: SAMPLE_QUESTIONS,
    attemptTimeoutMs: local ? LOCAL_TEST_DEADLINE_MS : config.attemptTimeoutMs,
    deadlineMs: local ? LOCAL_TEST_DEADLINE_MS : TEST_DEADLINE_MS
  })
  if (outcome.status !== 'ok') {
    const message = describeTypesafeReason(outcome.reason, provider.kind === 'typesafe' ? null : provider)
    const detail = outcome.detail ?? null
    return { ok: false, error: detail ? `${message} (${detail})` : message, reason: outcome.reason, detail, latencyMs: outcome.latencyMs }
  }
  const reported = outcome.response.model || provider.modelId
  if (provider.kind === 'typesafe') {
    return { ok: true, model: reported, latencyMs: outcome.latencyMs, message: `${reported} answered in ${outcome.latencyMs} ms.` }
  }
  const where = judgeWhereText(provider)
  return {
    ok: true,
    model: reported,
    latencyMs: outcome.latencyMs,
    message: `${judgeModelName({ kind: provider.kind, modelId: reported })} (${judgeServiceName(provider)}) answered${where ? ` ${where}` : ''} in ${outcome.latencyMs} ms.`
  }
}

/** Ask Jev the fixed sample question with this key. Never throws; a failure is a described result. */
export async function testTypesafeKey(apiKey: string): Promise<TypesafeKeyTestResult> {
  const config = await getTypesafeConfig()
  return testJudgeProvider(builtinTypesafeProvider(config), apiKey)
}
