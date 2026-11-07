/**
 * Fields a paused API reply keeps on its own record for the same call's approval resume, and that
 * never leave the server: the whiteboard's frozen DCM fragment and SA-137's live-file-read replay
 * (up to 1 MiB of file text). They are stripped at every door to a tab or an archive: the message
 * GET route, SSE `end` and the reply the handler returns, `complete_message`, and backup export and
 * restore (SA-137 D7, R1). Not in the shared message list readers: server writers (the approval
 * update) read records through those and write them back whole, and must keep the fields.
 */
export const SERVER_REPLAY_FIELDS = ['whiteboardContextSnapshot', 'liveFileReadSnapshot'] as const

/** The record as it may leave the server: the same object when it carries no replay field. */
export function withoutServerReplayFields<T>(record: T): T {
  const metadata = (record as { metadata?: unknown } | null)?.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return record
  if (!SERVER_REPLAY_FIELDS.some((field) => field in metadata)) return record
  const kept: Record<string, unknown> = { ...(metadata as Record<string, unknown>) }
  for (const field of SERVER_REPLAY_FIELDS) delete kept[field]
  return { ...(record as Record<string, unknown>), metadata: kept } as T
}
