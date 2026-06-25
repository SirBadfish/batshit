import { upstashKvGet, upstashKvSet } from '$lib/server/services/upstashKv'

export type RegistryCronProofName = 'model-catalog' | 'compatibility-matrix'
export type RegistryCronProofStatus = 'ok' | 'degraded' | 'failed'

export type RegistryCronProofRecord = {
  id: string
  name: RegistryCronProofName
  route: string
  status: RegistryCronProofStatus
  startedAt: string
  completedAt: string
  durationMs: number
  userAgent?: string | null
  vercelCron: boolean
  vercelId?: string | null
  deployment?: {
    region?: string | null
    url?: string | null
    gitCommitSha?: string | null
  }
  summary: Record<string, unknown>
  error?: string | null
}

export type RegistryCronProofIndexEntry = Pick<
  RegistryCronProofRecord,
  'id' | 'name' | 'route' | 'status' | 'startedAt' | 'completedAt' | 'durationMs' | 'vercelCron'
>

const PROOF_PREFIX = 'registry:cron-proof:v1:'
const PROOF_INDEX_KEY = 'registry:cron-proof:index:v1'
const PROOF_LATEST_KEY_PREFIX = 'registry:cron-proof:latest:v1:'
const PROOF_LATEST_RECORD_KEY_PREFIX = 'registry:cron-proof:latest-record:v1:'
const MAX_INDEX_ENTRIES = 50

function normalizeIndexEntry(raw: unknown): RegistryCronProofIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Partial<RegistryCronProofIndexEntry>
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return null
  if (entry.name !== 'model-catalog' && entry.name !== 'compatibility-matrix') return null

  const status: RegistryCronProofStatus =
    entry.status === 'degraded' || entry.status === 'failed' ? entry.status : 'ok'

  return {
    id: entry.id,
    name: entry.name,
    route: typeof entry.route === 'string' ? entry.route : '',
    status,
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : entry.id,
    completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : entry.id,
    durationMs: typeof entry.durationMs === 'number' ? Math.max(0, entry.durationMs) : 0,
    vercelCron: Boolean(entry.vercelCron)
  }
}

function buildProofId(name: RegistryCronProofName, completedAt: string) {
  return `${name}:${completedAt.replace(/[:.]/g, '-')}`
}

export function buildCronProofRequestMetadata(request: Request) {
  const userAgent = request.headers.get('user-agent')
  return {
    userAgent,
    vercelCron:
      Boolean(userAgent?.toLowerCase().includes('vercel-cron')) ||
      request.headers.get('x-vercel-cron') === '1',
    vercelId: request.headers.get('x-vercel-id')
  }
}

export async function storeRegistryCronProof({
  name,
  route,
  status,
  startedAt,
  completedAt,
  userAgent,
  vercelCron,
  vercelId,
  summary,
  error
}: Omit<RegistryCronProofRecord, 'id' | 'durationMs' | 'deployment'>): Promise<RegistryCronProofRecord> {
  const id = buildProofId(name, completedAt)
  const parsedDurationMs = Date.parse(completedAt) - Date.parse(startedAt)
  const durationMs = Number.isFinite(parsedDurationMs) ? Math.max(0, parsedDurationMs) : 0
  const record: RegistryCronProofRecord = {
    id,
    name,
    route,
    status,
    startedAt,
    completedAt,
    durationMs,
    userAgent,
    vercelCron,
    vercelId,
    deployment: {
      region: process.env.VERCEL_REGION ?? null,
      url: process.env.VERCEL_URL ?? null,
      gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null
    },
    summary,
    error
  }

  const existing = await upstashKvGet<unknown>(PROOF_INDEX_KEY)
  const currentIndex = Array.isArray(existing) ? existing : []
  const normalized = currentIndex
    .map((entry) => normalizeIndexEntry(entry))
    .filter((entry): entry is RegistryCronProofIndexEntry => Boolean(entry))

  const indexEntry: RegistryCronProofIndexEntry = {
    id: record.id,
    name: record.name,
    route: record.route,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    vercelCron: record.vercelCron
  }
  const nextIndex = [indexEntry, ...normalized.filter((entry) => entry.id !== id)].slice(
    0,
    MAX_INDEX_ENTRIES
  )

  await Promise.all([
    upstashKvSet(`${PROOF_PREFIX}${id}`, record),
    upstashKvSet(PROOF_INDEX_KEY, nextIndex),
    upstashKvSet(`${PROOF_LATEST_KEY_PREFIX}${name}`, id),
    upstashKvSet(`${PROOF_LATEST_RECORD_KEY_PREFIX}${name}`, record)
  ])

  return record
}
