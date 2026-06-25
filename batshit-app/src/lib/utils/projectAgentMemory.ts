export const LAST_PROJECT_BY_AGENT_STORAGE_KEY = 'batshit:lastProjectByAgent'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

type ProjectCandidate = {
  id: string
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage
  if (typeof localStorage !== 'undefined') return localStorage
  return null
}

export function readLastProjectByAgent(storage?: StorageLike | null): Record<string, string> {
  const targetStorage = resolveStorage(storage)
  if (!targetStorage) return {}

  try {
    const raw = targetStorage.getItem(LAST_PROJECT_BY_AGENT_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

export function rememberLastProjectForAgent(
  agentId: string | null | undefined,
  projectId: string | null | undefined,
  storage?: StorageLike | null
) {
  const normalizedAgentId = agentId?.trim()
  const normalizedProjectId = projectId?.trim()
  const targetStorage = resolveStorage(storage)

  if (!targetStorage || !normalizedAgentId || !normalizedProjectId) return

  const next = readLastProjectByAgent(targetStorage)
  next[normalizedAgentId] = normalizedProjectId
  targetStorage.setItem(LAST_PROJECT_BY_AGENT_STORAGE_KEY, JSON.stringify(next))
}

export function resolveProjectIdForAgent(params: {
  agentId: string | null | undefined
  projects: ProjectCandidate[]
  defaultProjectId?: string | null
  storage?: StorageLike | null
}) {
  const byId = new Set(params.projects.map((project) => project.id))
  const rememberedProjectId = params.agentId
    ? readLastProjectByAgent(params.storage)[params.agentId]
    : null

  if (rememberedProjectId && byId.has(rememberedProjectId)) {
    return rememberedProjectId
  }

  const defaultProjectId = params.defaultProjectId?.trim()
  if (defaultProjectId && byId.has(defaultProjectId)) {
    return defaultProjectId
  }

  return params.projects[0]?.id ?? null
}
