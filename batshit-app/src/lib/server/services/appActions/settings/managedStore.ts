import { readAutoCompactSnapshot } from '$lib/server/autoCompactGuard'
import { readConfiguredTtsTarget } from './configuredTtsSources'
import { AbortError } from 'redis'
import { redis } from '$lib/server/redis'
import { createAdmittedAgentSettingsExecutors, createConditionalSettingsStore } from './conditionalAgentSettings'
import { refuseSettings, type SettingsOwnerContext } from '$lib/appActions/settings/validation'
import { readModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import { readInstructionTextSnapshot } from './instructionTextSnapshot'

export const managedSettingsStore = {
  readConfiguredTts: readConfiguredTtsTarget,
  readAutoCompact(userId: string, id: string) { return redis.execute(client => readAutoCompactSnapshot(client, id, userId)) }, ...createConditionalSettingsStore(operation => redis.execute(operation), error => error instanceof AbortError, { captureIncarnation: true }),
  readInstructions(userId: string, id: string, kind: 'primary' | 'subagent', options: { includeText: boolean; prompt?: boolean }) {
    return readInstructionTextSnapshot({ kind, id }, userId, (script, args) => redis.execute(client => client.eval(script, args)), options)
  },
  readSelection(id: string, kind: 'primary' | 'subagent' = 'primary') { return redis.execute(client => readModelSelectionSnapshot(client, id, kind === 'primary' ? 'agent' : 'subagent', undefined, [], { reportProjection: true })) } }
export const admittedAgentSettings = createAdmittedAgentSettingsExecutors(managedSettingsStore, (context: SettingsOwnerContext) => {
  context.check()
  if (!context.authorityFence?.paths.length || !context.deadlineAt ||
    context.actor.kind !== 'agent' && context.actor.kind !== 'portable') refuseSettings('authority_required')
})
