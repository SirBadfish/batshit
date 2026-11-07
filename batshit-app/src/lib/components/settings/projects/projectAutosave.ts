import { resetProjectSaveAnswersForTests } from '$lib/projects/projectSaveAnswers'

/**
 * BL-2384: the one owner of Settings > Projects saves, one ordered lane PER PROJECT.
 *
 * It lives at module level, not in the panel, because a save outlives the mounted panel: a panel
 * closed with an edit still waiting sends it at once (`flushQueuedProjectSaves`), and a reopened
 * panel reads the project list only after those writes settle (`waitForProjectSaves`), so its
 * copy is never older than a save it did not see. Like `modelPresetAutosave.ts`:
 *
 * - typing coalesces into one waiting copy per project (a 600 ms delay), replaced by each edit;
 * - admitted writes of one project run one after another, so an older write never lands last;
 * - an edit equal to the latest copy already waiting or on its way sends nothing again;
 * - `latestProjectDraft` is the newest copy of a project not yet confirmed, which a reselected
 *   project shows instead of the older saved list copy;
 * - a failed write is not retried by itself: only the user's next edit sends again;
 * - every copy gets a revision, so a caller can tell whether a copy it took back is still the
 *   newest one (a failed delete puts its cancelled copy back only then).
 *
 * Volatile browser state only: the saved record stays the `/api/projects` route's.
 */
type Lane<F> = {
  timer: ReturnType<typeof setTimeout> | null
  queued: { form: F; signature: string; revision: number; run: (form: F) => Promise<void> } | null
  admitted: Array<{ form: F; signature: string; revision: number }>
  chain: Promise<void>
  /** The project was deleted: admitted copies not yet sent are skipped. */
  dropped: boolean
}

const lanes = new Map<string, Lane<any>>()
let lastRevision = 0

/**
 * How long a reopened panel waits for earlier writes before it reads anyway (BL-2384 round 4):
 * a write has no time limit of its own, and one that never answers must not hold the panel on
 * "Loading projects…". A copy still on its way keeps showing through `latestProjectDraft`.
 */
export const PROJECT_SAVES_READ_WAIT_MS = 3000

function laneFor<F>(projectId: string): Lane<F> {
  let lane = lanes.get(projectId) as Lane<F> | undefined
  if (!lane) {
    lane = { timer: null, queued: null, admitted: [], chain: Promise.resolve(), dropped: false }
    lanes.set(projectId, lane)
  }
  return lane
}

function admit<F>(
  projectId: string,
  lane: Lane<F>,
  form: F,
  signature: string,
  revision: number,
  run: (form: F) => Promise<void>
) {
  const entry = { form, signature, revision }
  lane.admitted.push(entry)
  const work = lane.chain.then(() => (lane.dropped ? undefined : run(form)))
  lane.chain = work.then(
    () => {},
    () => {}
  ).then(() => {
    lane.admitted = lane.admitted.filter((item) => item !== entry)
    if (!lane.timer && !lane.queued && lane.admitted.length === 0 && lanes.get(projectId) === lane) {
      lanes.delete(projectId)
    }
  })
  return work
}

/** The newest copy of a project that is waiting or on its way, or null when none is. */
export function latestProjectDraft<F>(projectId: string): F | null {
  const lane = lanes.get(projectId) as Lane<F> | undefined
  if (!lane) return null
  return lane.queued?.form ?? lane.admitted.at(-1)?.form ?? null
}

/** Whether a copy of the project other than `answered` is waiting or on its way. */
export function hasOtherProjectCopy<F>(projectId: string, answered: F): boolean {
  const lane = lanes.get(projectId) as Lane<F> | undefined
  if (!lane) return false
  return lane.queued !== null || lane.admitted.some((entry) => entry.form !== answered)
}

/** The revision of the newest copy waiting or on its way for a project (0 when none). */
export function latestProjectRevision(projectId: string): number {
  const lane = lanes.get(projectId)
  if (!lane) return 0
  return Math.max(lane.queued?.revision ?? 0, ...lane.admitted.map((item) => item.revision))
}

function latestSignature(projectId: string): string | null {
  const lane = lanes.get(projectId)
  if (!lane) return null
  return lane.queued?.signature ?? lane.admitted.at(-1)?.signature ?? null
}

/** Queue an autosave: it waits `delay` ms for more typing, then joins the project's ordered lane. */
/** Answers whether a new copy was queued (false: an equal copy is already waiting or on its way). */
export function queueProjectSave<F>(
  projectId: string,
  form: F,
  signature: string,
  run: (form: F) => Promise<void>,
  delay = 600
): boolean {
  if (latestSignature(projectId) === signature) return false
  const lane = laneFor<F>(projectId)
  if (lane.timer) clearTimeout(lane.timer)
  lane.queued = { form, signature, revision: ++lastRevision, run }
  lane.timer = setTimeout(() => {
    lane.timer = null
    const queued = lane.queued
    lane.queued = null
    if (queued) void admit(projectId, lane, queued.form, queued.signature, queued.revision, queued.run).catch(() => {})
  }, delay)
  return true
}

/**
 * Save now, behind any write of this project already on its way (an editor's explicit Save).
 * Its form already carries every earlier edit, so a waiting copy is replaced, not sent too.
 * Rejects with the save's own error.
 */
export function saveProjectNow<F>(projectId: string, form: F, signature: string, run: (form: F) => Promise<void>) {
  cancelQueuedProjectSave(projectId)
  return admit(projectId, laneFor<F>(projectId), form, signature, ++lastRevision, run)
}

/**
 * Drop the waiting copy of a project (its edits returned to the saved copy, or it is being
 * deleted). Returns it with its revision, so it can be put back only while nothing newer waits.
 */
export function cancelQueuedProjectSave<F>(projectId: string): { form: F; revision: number } | null {
  const lane = lanes.get(projectId) as Lane<F> | undefined
  if (!lane) return null
  if (lane.timer) clearTimeout(lane.timer)
  lane.timer = null
  const queued = lane.queued ? { form: lane.queued.form, revision: lane.queued.revision } : null
  lane.queued = null
  if (lane.admitted.length === 0) lanes.delete(projectId)
  return queued
}

/** A panel closing: every waiting copy is a completed edit, so send it now. */
export function flushQueuedProjectSaves() {
  for (const [projectId, lane] of lanes) {
    if (!lane.queued) continue
    if (lane.timer) clearTimeout(lane.timer)
    lane.timer = null
    const queued = lane.queued
    lane.queued = null
    void admit(projectId, lane, queued.form, queued.signature, queued.revision, queued.run).catch(() => {})
  }
}

/**
 * A project's delete succeeded: drop its waiting copy and skip its admitted copies not yet sent,
 * so no PUT follows for a project that is gone. A write already on its way still answers (404).
 */
export function dropProjectLane(projectId: string) {
  const lane = lanes.get(projectId)
  if (!lane) return
  if (lane.timer) clearTimeout(lane.timer)
  lane.timer = null
  lane.queued = null
  lane.dropped = true
  lanes.delete(projectId)
}

// Saved answers (BL-2384 round 5) live in `$lib/projects/projectSaveAnswers.ts`, where every
// project list read can apply them; they are re-exported here for the Settings panel.
export {
  onProjectSaved,
  projectAnswerSeq,
  projectAnswersSince,
  publishProjectSaved,
  type SavedProjectAnswer
} from '$lib/projects/projectSaveAnswers'

/**
 * Settles when every write admitted so far has answered, or after `limitMs`, whichever comes
 * first (a reopened panel reads after it). Answers whether the writes settled in time.
 */
export function waitForProjectSaves(limitMs = PROJECT_SAVES_READ_WAIT_MS): Promise<boolean> {
  if (lanes.size === 0) return Promise.resolve(true)
  const settled = Promise.all([...lanes.values()].map((lane) => lane.chain)).then(() => true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), limitMs)
  })
  return Promise.race([settled, limit]).finally(() => clearTimeout(timer))
}

/** Tests only: forget every lane and answer without sending anything. */
export function resetProjectAutosaveForTests() {
  for (const lane of lanes.values()) if (lane.timer) clearTimeout(lane.timer)
  lanes.clear()
  resetProjectSaveAnswersForTests()
}
