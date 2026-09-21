import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { apiError } from '$lib/server/services/apiResponses'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { computeQuickAction, QUICK_ACTION_LIMITS } from '$lib/server/services/quickActions.jev'
import { requireUser } from '$lib/server/services/routeSecurity'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'
import { QUICK_ACTION_FEATURE_ID, resolveJevQuickActionsEnabled } from '$lib/utils/jevJuiceQuickActions'

/**
 * SA-120 P9 — one spoken turn's quick-action check (F2, DL-120-15).
 *
 * The browser calls this from the one place a Voice Mode turn is committed, BEFORE it decides
 * whether to send the turn to the agent at all. The answer is a decision, never an act: the
 * browser runs the action (each one is a click the user could make), stores the mark on the
 * user message, and the next turn's DCM tells the agent (`buildQuickActionTellProvider`).
 *
 * The switch (`voice_settings.voiceMode.jevJuiceQuickActions`, LS-060) is re-read here from the
 * user's own record, so a stale page can never make a call the settings do not allow; the master
 * switch and the key are re-checked inside `runTypesafeJudgment`. Every call, fired or not,
 * gets its own Execution Viewer entry (`qa_…`), because a swallowed turn has no run to ride
 * (DL-120-07). What leaves the machine: the words of this one turn and the catalog's names.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return apiError('Invalid JSON body', 400)
  }
  const said = typeof body?.said === 'string' ? body.said.replace(/\s+/g, ' ').trim() : ''
  if (!said) return apiError('`said` is required.', 400)
  // P9b: what the user actually spoke, wake word included, for the Execution Viewer entry only.
  const spoken = typeof body?.spoken === 'string' && body.spoken.trim() ? body.spoken.replace(/\s+/g, ' ').trim().slice(0, QUICK_ACTION_LIMITS.maxSaidChars + 32) : said
  if (said.length > QUICK_ACTION_LIMITS.maxSaidChars) {
    // Not an error a user can act on: a long turn is not a quick action. Say so plainly.
    return json({ action: null, tab: null, onlyThis: false, confidence: 0, skipped: 'too_long', snapshotId: null })
  }
  const sessionId = typeof body.sessionId === 'string' && SESSION_ID_PATTERN.test(body.sessionId) ? body.sessionId : null
  const agentId = typeof body.agentId === 'string' && SESSION_ID_PATTERN.test(body.agentId) ? body.agentId : null

  try {
    const settings = await redis.getUserSettings(user.value.id)
    const featureEnabled = resolveJevQuickActionsEnabled(normalizeVoiceSettings(settings?.voice_settings).voiceMode)
    const outcome = await computeQuickAction({ userId: user.value.id, said, featureEnabled })

    let snapshotId: string | null = null
    if (outcome.record && sessionId) {
      // The check's own Execution Viewer entry: a call with no turn still has a row.
      const agent = agentId ? await redis.get(`agent:${agentId}`) : null
      const ownAgent = agent && (agent as { user_id?: unknown }).user_id === user.value.id ? (agent as Record<string, unknown>) : null
      snapshotId = `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      try {
        await executionViewerService.recordSnapshot({
          id: snapshotId,
          sessionId,
          userId: user.value.id,
          agentId: ownAgent ? String(ownAgent.id ?? agentId) : null,
          agentName: ownAgent ? String(ownAgent.displayName ?? ownAgent.name ?? agentId) : 'Batshit',
          agentType: 'quick_action',
          createdAt: new Date().toISOString(),
          userMessage: spoken,
          structuredInput: null,
          executionMetadata: {
            typesafeCalls: [outcome.record],
            quickActionJudged: said,
            quickAction: outcome.decision
              ? { id: outcome.decision.action, tab: outcome.decision.tab, onlyThis: outcome.decision.onlyThis, confidence: outcome.decision.confidence }
              : null
          }
        })
      } catch (error) {
        console.error('[Jev Juice] quick action: failed to record the Execution Viewer entry:', error)
        snapshotId = null
      }
    }

    const decision = outcome.decision
    return json({
      action: decision?.action ?? null,
      tab: decision?.tab ?? null,
      onlyThis: decision?.onlyThis ?? false,
      confidence: decision?.confidence ?? 0,
      skipped: outcome.record && outcome.record.status !== 'ok' ? outcome.record.reason ?? outcome.record.status : null,
      snapshotId,
      feature: QUICK_ACTION_FEATURE_ID
    })
  } catch (error) {
    console.error('[Jev Juice] quick action check failed:', error)
    // A failed check must never block a spoken turn: the browser sends it as usual.
    return json({ action: null, tab: null, onlyThis: false, confidence: 0, skipped: 'local_error', snapshotId: null })
  }
}
