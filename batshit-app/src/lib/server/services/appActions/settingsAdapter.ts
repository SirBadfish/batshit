import { AppActionRefusal, refuse } from '$lib/appActions/catalog'
import { APP_ACTION_DEADLINE_MS } from '$lib/appActions/protocol'
import { SettingsActionRefusal } from '$lib/appActions/settings/validation'
import type { SettingsOwnerContext } from '$lib/appActions/settings/validation'
import type { SettingsActionId } from '$lib/appActions/settingsContract'
import { validateInspection, validateOwnRead, validateOwnUpdate } from '$lib/appActions/settings/validation'
import { inspectSettings, ownAgentSettings } from './settings/server'
import { publishUserEvent } from '$lib/server/ssePublisher'

type AgentContext = { userId: string; agentId?: string | null; abortSignal?: AbortSignal }
function ownerContext(context: AgentContext): SettingsOwnerContext {
  if (!context.agentId) refuse('agent_identity_required')
  const deadlineAt = Date.now() + APP_ACTION_DEADLINE_MS
  // These two fields are the reviewed V2 owner seam. Never accepted as tool args.
  const owner: SettingsOwnerContext = {
    actor: { kind: 'agent', userId: context.userId, actingAgentId: context.agentId },
    ...(context.abortSignal instanceof AbortSignal ? { signal: context.abortSignal } : {}), deadlineAt,
    check() {
      if (context.abortSignal?.aborted) refuse('caller_stopped')
      if (Date.now() >= deadlineAt) refuse('expired_request')
    }
  }
  return owner
}
async function settingsResult(operation: () => Promise<unknown>): Promise<Record<string, any>> {
  try { return await operation() as Record<string, any> }
  catch (error) {
    if (error instanceof SettingsActionRefusal || error instanceof AppActionRefusal) return { status: 'blocked', reason: error.reason }
    throw error
  }
}

/**
 * LS-067/LS-068 (SA-122 A-1y): no tab made the agent's own Settings save, so every tab of the user
 * hears `agent_settings_changed` on the user channel and reads the agent again. Only a save that was
 * sent: saved, or sent with its answer lost (`saved: 'unknown'`, where a read settles what is
 * stored). A refused or never-sent save changed nothing and says nothing. Publication is not proof
 * that a tab showed it, so the result keeps `visible: 'unknown'`. `publishUserEvent` never throws.
 */
async function announceAgentSettingsChange(userId: string, subjectAgentId: string, family: 'memory' | 'identity', result: { saved?: string }) {
  if (result.saved !== 'saved' && result.saved !== 'unknown') return
  await publishUserEvent(userId, { type: 'agent_settings_changed', agentId: subjectAgentId, family })
}

/** Called only by the five fixed Fabric definitions after scope, identity and consent. */
export async function executeAgentSettingsAction(context: AgentContext, id: SettingsActionId, args: unknown) {
  const owner = ownerContext(context)
  return settingsResult(async () => {
    owner.check()
    switch (id) {
      case 'settings.inspect': return inspectSettings(validateInspection(args), owner)
      case 'settings.agent.memory.read': return ownAgentSettings.readMemory(validateOwnRead(args), owner)
      case 'settings.agent.identity.read': return ownAgentSettings.readIdentity(validateOwnRead(args), owner)
      case 'settings.agent.memory.update': {
        const request = validateOwnUpdate(args, 'memory')
        const result = await ownAgentSettings.updateMemory(request, owner)
        await announceAgentSettingsChange(context.userId, request.subjectAgentId, 'memory', result)
        return result
      }
      case 'settings.agent.identity.update': {
        const request = validateOwnUpdate(args, 'identity')
        const result = await ownAgentSettings.updateIdentity(request, owner)
        await announceAgentSettingsChange(context.userId, request.subjectAgentId, 'identity', result)
        return result
      }
      default: refuse('unsupported_action')
    }
  })
}

/** The cookie developer route has one read-only server capability, no agent mutation. */
export async function inspectDeveloperSettings(userId: string, args: unknown, signal?: AbortSignal) {
  return settingsResult(() => inspectSettings(validateInspection(args), { actor: { kind: 'developer', userId },
    check() { if (signal?.aborted) refuse('caller_stopped') } }))
}
