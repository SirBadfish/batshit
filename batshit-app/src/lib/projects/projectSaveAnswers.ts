/**
 * BL-2384 round 5: saved Project answers, shared by every reader of the project list.
 *
 * A Settings > Projects save outlives the panel that sent it (`projectAutosave.ts`), and a
 * reopened panel waits for it only a bounded time. So a save's answer goes to whichever panel is
 * mounted, not only to the sender (`onProjectSaved`), and every project list read corrects its
 * answer with the saved answers that arrived after the read began (`applySavedAnswersSince`,
 * used by `ProjectService.loadProjects`): the server may have read the list before that write
 * landed, and such a list must never put old values (a root path chat sends) back in the store.
 *
 * The sender updates the project store itself before it publishes. Browser memory only; a
 * page reload starts empty, and its list read then reflects every write that answered.
 */
export type SavedProjectAnswer<P, F> = { seq: number; projectId: string; project: P; submitted: F }

const ANSWERS_KEPT = 50
let lastAnswerSeq = 0
const recentAnswers: Array<SavedProjectAnswer<any, any>> = []
const answerListeners = new Set<(answer: SavedProjectAnswer<any, any>) => void>()

export function publishProjectSaved<P, F>(projectId: string, project: P, submitted: F) {
  const answer: SavedProjectAnswer<P, F> = { seq: ++lastAnswerSeq, projectId, project, submitted }
  recentAnswers.push(answer)
  if (recentAnswers.length > ANSWERS_KEPT) recentAnswers.splice(0, recentAnswers.length - ANSWERS_KEPT)
  for (const listener of [...answerListeners]) listener(answer)
}

/** Listen for every saved answer; returns the unsubscribe. */
export function onProjectSaved<P, F>(listener: (answer: SavedProjectAnswer<P, F>) => void): () => void {
  answerListeners.add(listener)
  return () => answerListeners.delete(listener)
}

/** The sequence of the latest saved answer; a list reader captures it before its read. */
export function projectAnswerSeq(): number {
  return lastAnswerSeq
}

/** The saved answers that arrived after `seq`, oldest first. */
export function projectAnswersSince<P, F>(seq: number): Array<SavedProjectAnswer<P, F>> {
  return recentAnswers.filter((answer) => answer.seq > seq)
}

function stampOf(project: { updated_at?: unknown }): number {
  return typeof project.updated_at === 'string' ? Date.parse(project.updated_at) : Number.NaN
}

/**
 * Whether `candidate` may replace `current`: unless `current` is known to be newer (the server
 * stamps `updated_at` on every update, `redis.ts`). An unknown stamp never blocks the candidate.
 */
export function isNotOlderCopy(candidate: { updated_at?: unknown }, current: { updated_at?: unknown }): boolean {
  const candidateStamp = stampOf(candidate)
  const currentStamp = stampOf(current)
  if (Number.isNaN(currentStamp)) return true
  if (Number.isNaN(candidateStamp)) return false
  return candidateStamp >= currentStamp
}

/**
 * A list read's answer with every saved answer since `seq` laid over it, each only where it is
 * not older than the list's copy (round 6): a list that already holds a newer write keeps it.
 */
export function applySavedAnswersSince<P extends { id: string; updated_at?: unknown }>(projects: P[], seq: number): P[] {
  let next = projects
  for (const answer of projectAnswersSince<P, unknown>(seq)) {
    next = next.map((project) =>
      project.id === answer.projectId && isNotOlderCopy(answer.project, project) ? answer.project : project
    )
  }
  return next
}

/** Tests only. */
export function resetProjectSaveAnswersForTests() {
  recentAnswers.length = 0
  answerListeners.clear()
}
