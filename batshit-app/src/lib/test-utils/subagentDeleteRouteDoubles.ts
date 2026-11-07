import { vi } from 'vitest'

type AuthorityModule = typeof import('$lib/server/services/appActions/settings/authority')
type SlashCommandRevisionModule = typeof import('$lib/server/services/slashCommandRevision')
type SubjectPopulationModule = typeof import('$lib/server/services/subjectPopulation')
type ArtifactAccessCleanupModule = typeof import('$lib/server/services/artifactAgentAccessCleanup')

/**
 * Doubles for the fixed Lua owners `DELETE /api/subagents/[id]` reaches, shared by the Subagent
 * delete-route suites so their copies cannot drift. Since b34b0e201 the delete captures its
 * slash-command write basis through EVAL before anything else, and the default lane's Redis fake
 * deliberately has no generic EVAL (`vitest-setup.ts`). Each owner is qualified by its own
 * real-Redis suite; a route suite holds these boundaries to test the route's ordering and custody.
 *
 * Each double is the body of a `vi.mock` factory (hoisted, so it is loaded inside the factory):
 *
 *   vi.mock('$lib/server/services/slashCommandRevision', async importOriginal =>
 *     (await import('$lib/test-utils/subagentDeleteRouteDoubles')).slashCommandRevisionDouble(await importOriginal()))
 *
 * `lanes: 'default'` keeps the actual owners on the real lane (`npm run test:redis`), where EVAL
 * exists; `'both'` holds them on both lanes. The access-list doubles scrub the id by JSON path, so
 * a suite's scrub assertions (BL-187, BL-392) still see a real write. Modules are imported inside
 * the doubles, at call time, so loading this file never re-enters a module being mocked.
 */
export type DeleteRouteDoubleLanes = 'both' | 'default'

function keepsActual(lanes: DeleteRouteDoubleLanes) {
  return lanes === 'default' && process.env.VITEST_USE_REAL_REDIS === 'true'
}

/** App Actions authority sweep (its own owner proof); the route only has to call it. */
export function appActionsAuthorityDouble(actual: AuthorityModule, lanes: DeleteRouteDoubleLanes = 'both'): AuthorityModule {
  if (keepsActual(lanes)) return actual
  return { ...actual, sweepAppActionsSubjectReferences: vi.fn(async () => {}) }
}

/** Write-basis capture, a skill's and a skill source's access-list scrub. */
export function slashCommandRevisionDouble(actual: SlashCommandRevisionModule, lanes: DeleteRouteDoubleLanes = 'both'): SlashCommandRevisionModule {
  if (keepsActual(lanes)) return actual
  return {
    ...actual,
    captureSlashCommandWriteBasis: vi.fn(async (preparation: Parameters<SlashCommandRevisionModule['captureSlashCommandWriteBasis']>[0]) => {
      const { slashCommandPreparationState } = await import('$lib/server/services/slashCommandRevisionProtocol')
      const state = slashCommandPreparationState(preparation)
      if (state.revision === undefined) state.revision = null
      return Object.freeze({}) as Awaited<ReturnType<SlashCommandRevisionModule['captureSlashCommandWriteBasis']>>
    }),
    captureSkillSourceWriteBasis: vi.fn(async () =>
      Object.freeze({}) as Awaited<ReturnType<SlashCommandRevisionModule['captureSkillSourceWriteBasis']>>),
    commitSlashCommandAgentAccess: vi.fn(async (userId: string, commandId: string, id: string) => {
      const { redis } = await import('$lib/server/redis')
      const key = `slash_command:${userId}:${commandId}`
      const row = await redis.json.get(key) as { enabled_agent_ids?: string[] } | null
      if (!row) return 'MISSING' as const
      if (!Array.isArray(row.enabled_agent_ids) || !row.enabled_agent_ids.includes(id)) return 'UNCHANGED' as const
      await redis.json.set(key, '$.enabled_agent_ids', row.enabled_agent_ids.filter(value => value !== id) as never)
      return 'OK' as const
    }),
    removeExplicitSkillSourceAgentAccess: vi.fn(async (userId: string, sourceId: string, id: string) => {
      const { redis } = await import('$lib/server/redis')
      const key = `skill_source:${userId}:${sourceId}`
      const row = await redis.json.get(key) as { enabled_agent_ids?: string[] } | null
      if (!row || !Array.isArray(row.enabled_agent_ids) || !row.enabled_agent_ids.includes(id)) return false
      await redis.json.set(key, '$.enabled_agent_ids', row.enabled_agent_ids.filter(value => value !== id) as never)
      return true
    })
  } as SlashCommandRevisionModule
}

/** The record's physical deletion: its list entry and record, without the catalogue revision fence. */
export function subjectPopulationDouble(actual: SubjectPopulationModule, lanes: DeleteRouteDoubleLanes = 'both'): SubjectPopulationModule {
  if (keepsActual(lanes)) return actual
  return {
    ...actual,
    deleteSubagentPopulation: vi.fn(async (client: any, subject: { userId: string; subjectId: string }) => {
      await client.sRem(`user:${subject.userId}:subagents`, subject.subjectId)
      return await client.del(`subagent:${subject.subjectId}`) ? 'DELETED' as const : 'MISSING' as const
    })
  } as SubjectPopulationModule
}

/** The fixed five-path Artifact access cleanup (its own 13-case Redis suite): checks, then changes nothing. */
export function artifactAgentAccessCleanupDouble(actual: ArtifactAccessCleanupModule, lanes: DeleteRouteDoubleLanes = 'both'): ArtifactAccessCleanupModule {
  if (keepsActual(lanes)) return actual
  return {
    ...actual,
    removeArtifactAgentReferences: vi.fn(async (_args: Parameters<ArtifactAccessCleanupModule['removeArtifactAgentReferences']>[0],
      context: Parameters<ArtifactAccessCleanupModule['removeArtifactAgentReferences']>[1]) => {
      context.checkBeforeIssue()
      return { status: 'unchanged' } as Awaited<ReturnType<ArtifactAccessCleanupModule['removeArtifactAgentReferences']>>
    })
  }
}
