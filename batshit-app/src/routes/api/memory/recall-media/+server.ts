/**
 * SA-105 P3 — the managed CLI lane's delivery-time byte fetch (AMD-105-10).
 *
 * The helper bridge (`scripts/mode4-controls-mcp.cjs`) gets a BYTE-FREE recall
 * plan back from `/api/controls/use`, then posts that plan here. This route
 * resolves the lane for the calling CLI runtime, decides per image, loads the
 * bytes for whatever arrives in-turn, and returns the plan with its
 * `delivery` / `reason` / `media_note` fields written.
 *
 * Why a second hop rather than putting bytes in the control response:
 * DL-105-04 says bytes never enter a control result, because that object rides
 * into intermediate steps, the Execution Viewer and persisted history. This
 * keeps that literally true while still delivering in the same turn.
 *
 * Why the whole payload rather than a list of ids: every model-visible word —
 * the per-memory `media_note` especially — must come from one implementation.
 * Handing the bridge a finished payload keeps it a dumb pipe with no wording of
 * its own, so the API lane and the CLI lane cannot drift apart.
 *
 * Authorization is deliberately NOT widened. This route sits in the
 * `resolveNativeToolUser` family, exactly like `/api/controls/use`, and every
 * byte load goes through `loadManagedMemoryMedia`, which re-checks that the
 * caller's user owns the agent and that the media belongs to that memory. A
 * caller holding the service token can already run `sys.memory.recall`; this
 * adds no reach.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  resolveToolResultImageDelivery,
  type ToolResultImageRuntime
} from '$lib/server/services/toolResultImageDelivery'
import {
  applyRecallMediaDelivery,
  isRecallOutputWithMedia
} from '$lib/server/services/memory/memoryRecallDelivery'
import { loadManagedMemoryMedia } from '$lib/server/services/memory/memoryManage'

type RecallMediaRequest = {
  userId?: string
  agentId?: string
  /** Which managed CLI launched the bridge. Decides the lane. */
  runtime?: string
  /** The byte-free tool payload returned by `/api/controls/use`. */
  recall?: unknown
}

function normalizeRuntime(value: unknown): ToolResultImageRuntime | null {
  return value === 'codex' || value === 'claude' ? value : null
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as RecallMediaRequest | null
    if (!body || typeof body !== 'object') {
      return apiFailure('Invalid request body.', 400)
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })
    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) {
      return apiFailure('agentId is required.', 400)
    }

    const runtime = normalizeRuntime(body.runtime)
    if (!runtime) {
      // Fail loud rather than guessing a lane. Guessing `tool_result` for an
      // unknown runtime is precisely the failure this story exists to remove:
      // it would put a megabyte of base64 in front of a model that cannot read
      // it, or claim in-turn delivery for an image that never arrives.
      return apiFailure('runtime must be "codex" or "claude".', 400)
    }

    if (!isRecallOutputWithMedia(body.recall)) {
      return apiFailure('recall must be a sys.memory.recall payload carrying media.', 400)
    }

    // Capabilities are intentionally not passed: a managed CLI run has no
    // Batshit model preset to read them from, and `modelAllowsImageInput`
    // already treats unknown capabilities as allowed. The lane therefore comes
    // from the runtime alone, which is the only thing that actually decides
    // whether MCP image content reaches this model.
    const decision = resolveToolResultImageDelivery({ runtime })

    const delivered = await applyRecallMediaDelivery(body.recall, {
      lane: decision.lane,
      loadBytes: async ({ memoryId, mediaId }) => {
        const loaded = await loadManagedMemoryMedia(
          { userId: auth.userId, agentId },
          memoryId,
          mediaId
        )
        return { bytes: loaded.bytes }
      }
    })

    if (!delivered) {
      return apiFailure('recall payload carried no deliverable media.', 400)
    }

    return json({
      success: true,
      lane: delivered.record.lane,
      reason: decision.reason,
      recall: delivered.output,
      images: delivered.images,
      record: delivered.record
    })
  } catch (error) {
    console.error('[Memory Recall Media] failed:', error)
    return apiFailure(
      error instanceof Error ? error.message : 'Recall media delivery failed.',
      500
    )
  }
}
