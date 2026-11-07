import { DEFAULT_PROJECT_ID } from '$lib/projects/defaultProject'

export const LAST_PROJECT_BY_AGENT_STORAGE_KEY = 'batshit:lastProjectByAgent'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

type ProjectCandidate = {
  id: string
}

/**
 * A project picked in the Projects sidebar for one agent, with the agent's saved default project
 * it was picked against (`null`: the agent was on Default).
 *
 * BL-2372: a pick never outranks a newer save. When the agent's saved default is no longer the
 * one the pick was made against, the save came later: the pick is dropped and forgotten, so it
 * cannot come back if the default is later set back.
 */
export type RememberedProjectPick = {
  projectId: string
  againstDefaultProjectId: string | null
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage
  if (typeof localStorage !== 'undefined') return localStorage
  return null
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function isRememberedProjectPick(value: unknown): value is RememberedProjectPick {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pick = value as Record<string, unknown>
  return (
    typeof pick.projectId === 'string' &&
    pick.projectId.trim().length > 0 &&
    (pick.againstDefaultProjectId === null || typeof pick.againstDefaultProjectId === 'string')
  )
}

/**
 * Every agent's remembered pick. An entry written before BL-2372 (a bare project id) is not read:
 * it records no default, so no save could ever outrank it. The agent shows its saved default.
 */
export function readLastProjectByAgent(storage?: StorageLike | null): Record<string, RememberedProjectPick> {
  const targetStorage = resolveStorage(storage)
  if (!targetStorage) return {}

  try {
    const raw = targetStorage.getItem(LAST_PROJECT_BY_AGENT_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, RememberedProjectPick] =>
        isRememberedProjectPick(entry[1])
      )
    )
  } catch {
    return {}
  }
}

function writeLastProjectByAgent(next: Record<string, RememberedProjectPick>, storage: StorageLike) {
  try {
    storage.setItem(LAST_PROJECT_BY_AGENT_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Browser storage can refuse a write (private mode, quota). The pick still applies now;
    // it is just not remembered for the next visit.
  }
}

/**
 * The project an agent gets with no sidebar pick: its saved default project when that project
 * exists; nothing when it names a project that is gone (never another project instead); and on
 * Default, the Default Project when the user has a Default Project Path (BL-2373). Never the
 * first saved project: a saved project is never forced onto an agent on Default.
 */
export function resolveAgentDefaultProjectId(params: {
  projects: ProjectCandidate[]
  defaultProjectId?: string | null
}): string | null {
  const byId = new Set(params.projects.map((project) => project.id))
  const defaultProjectId = normalizeId(params.defaultProjectId)
  if (defaultProjectId) {
    return byId.has(defaultProjectId) ? defaultProjectId : null
  }
  return byId.has(DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : null
}

export function forgetLastProjectForAgent(
  agentId: string | null | undefined,
  storage?: StorageLike | null
) {
  const normalizedAgentId = normalizeId(agentId)
  const targetStorage = resolveStorage(storage)
  if (!targetStorage || !normalizedAgentId) return

  const next = readLastProjectByAgent(targetStorage)
  if (!(normalizedAgentId in next)) return
  delete next[normalizedAgentId]
  writeLastProjectByAgent(next, targetStorage)
}

/**
 * Remember a sidebar pick against the agent's saved default. A pick of the project the agent
 * would get anyway is no override, so it clears the memory instead.
 */
export function rememberLastProjectForAgent(params: {
  agentId: string | null | undefined
  projectId: string | null | undefined
  projects: ProjectCandidate[]
  defaultProjectId?: string | null
  storage?: StorageLike | null
}) {
  const normalizedAgentId = normalizeId(params.agentId)
  const normalizedProjectId = normalizeId(params.projectId)
  const targetStorage = resolveStorage(params.storage)

  if (!targetStorage || !normalizedAgentId || !normalizedProjectId) return

  if (normalizedProjectId === resolveAgentDefaultProjectId(params)) {
    forgetLastProjectForAgent(normalizedAgentId, targetStorage)
    return
  }

  const next = readLastProjectByAgent(targetStorage)
  next[normalizedAgentId] = {
    projectId: normalizedProjectId,
    againstDefaultProjectId: normalizeId(params.defaultProjectId)
  }
  writeLastProjectByAgent(next, targetStorage)
}

/**
 * The project the sidebar shows, and chat sends, for an agent: its remembered pick while that
 * pick was made against the agent's current saved default and still exists, else the agent's
 * default (`resolveAgentDefaultProjectId`). A pick outranked by a newer save is forgotten here.
 */
export function resolveProjectIdForAgent(params: {
  agentId: string | null | undefined
  projects: ProjectCandidate[]
  defaultProjectId?: string | null
  storage?: StorageLike | null
}): string | null {
  const agentId = normalizeId(params.agentId)
  const remembered = agentId ? readLastProjectByAgent(params.storage)[agentId] : undefined

  if (remembered) {
    if (remembered.againstDefaultProjectId !== normalizeId(params.defaultProjectId)) {
      forgetLastProjectForAgent(agentId, params.storage)
    } else if (params.projects.some((project) => project.id === remembered.projectId)) {
      return remembered.projectId
    }
  }

  return resolveAgentDefaultProjectId(params)
}
