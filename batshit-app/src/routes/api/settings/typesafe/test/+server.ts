import { json, type RequestHandler } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/services/routeSecurity'
import { getTypesafeConfig } from '$lib/server/services/typesafe/typesafeConfig'
import { resolveTypesafeApiKey } from '$lib/server/services/typesafe/typesafeAvailability'
import { resolveJudgeKey } from '$lib/server/services/typesafe/judgeProviderEndpoint'
import { testJudgeProvider } from '$lib/server/services/typesafe/typesafeKeyTest'
import { describeTypesafeReason } from '$lib/utils/jevJuice'
import { isJudgeProviderUsable, judgeKeyService, listJudgeProviders } from '$lib/utils/judgeProviders'

/**
 * SA-120 P10a (DL-120-18) — the Test button beside each judge on the Admin Judge Juice card.
 *
 * It tests the SAVED judge (the card disables it while an edit is unsaved), with the one fixed sample question
 * `typesafeKeyTest.ts` sends: never chat text. Like the API Keys Test it ignores the master switch, because the
 * user clicked it. A judge that takes no key (Ollama, a keyless System One URL) is tested with none. Admin only.
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
  const providerId = (body as { providerId?: unknown } | null)?.providerId
  if (typeof providerId !== 'string' || !providerId) {
    return json({ error: '`providerId` is required.' }, { status: 400 })
  }

  try {
    const config = await getTypesafeConfig()
    const provider = listJudgeProviders(config).find((entry) => entry.id === providerId)
    if (!provider) return json({ error: 'That judge is not saved yet. Wait for the card to save, then test again.' }, { status: 404 })
    if (!isJudgeProviderUsable(provider)) {
      return json({ ok: false, error: describeTypesafeReason('no_provider') }, { status: 400 })
    }
    const key = await resolveJudgeKey(provider, user.value.id, resolveTypesafeApiKey)
    if (judgeKeyService(provider) && !key) {
      return json({ ok: false, error: describeTypesafeReason('no_key', provider) }, { status: 400 })
    }
    const result = await testJudgeProvider(provider, key?.apiKey ?? null)
    return json(result, { status: result.ok ? 200 : 400 })
  } catch (error) {
    console.error('[Judge Juice Test] failed:', error)
    return json({ ok: false, error: 'Batshit could not run the test.' }, { status: 500 })
  }
}
