// Persistence admission outlives a mounted editor: reopening must wait for its old writes.
let saveCompletion: Promise<void> = Promise.resolve()

export type ModelPresetDraft<F, C, P = unknown> = {
  form: F
  codex: C
  signature: string
  persistedSignature: string | null
  error: string | null
  failedSignature: string | null
  numericDraft: boolean
  payload: P | null
}
// Volatile editor continuation only. Saved records still belong to the existing route/store.
const retainedDrafts = new Map<string, ModelPresetDraft<unknown, unknown>>()
export function getModelPresetDrafts<F, C, P = unknown>() {
  return retainedDrafts as Map<string, ModelPresetDraft<F, C, P>>
}

export function runModelPresetSave<T>(save: () => Promise<T>): Promise<T> {
  const work = saveCompletion.then(save)
  saveCompletion = work.then(() => {}, () => {})
  return work
}

export function waitForModelPresetSaves() {
  return saveCompletion
}

/** Coalesce drafts, but serialize admitted writes so an older save cannot win last. */
export function createModelPresetAutosave<T extends { id: string; signature: string; selection: number }>({
  delay,
  save,
  settled
}: {
  delay: number
  save: (draft: T) => Promise<void>
  settled: () => void
}) {
  const pending = new Map<string, { draft: T; ready: boolean; timer: ReturnType<typeof setTimeout> }>()
  let admitted: T | null = null
  let disposed = false

  function admit(draft: T) {
    return runModelPresetSave(() => save(draft))
  }

  async function drain() {
    if (admitted) return
    const next = [...pending.values()].find(item => item.ready)
    if (!next) return
    pending.delete(next.draft.id)
    admitted = next.draft
    const work = admit(next.draft)
    try {
      await work
    } finally {
      admitted = null
      if (!disposed) {
        settled()
      }
      void drain()
    }
  }

  function cancelPending(id: string) {
    const item = pending.get(id)
    if (item) clearTimeout(item.timer)
    pending.delete(id)
  }

  return {
    schedule(draft: T) {
      if (disposed) return
      const prior = pending.get(draft.id)?.draft ?? admitted
      if (prior?.id === draft.id && prior.signature === draft.signature && prior.selection === draft.selection) return
      cancelPending(draft.id)
      const item = {
        draft,
        ready: false,
        timer: setTimeout(() => {
          item.ready = true
          void drain()
        }, delay)
      }
      pending.set(draft.id, item)
    },
    cancelPending,
    hasWork(id: string) {
      return pending.has(id) || admitted?.id === id
    },
    dispose() {
      disposed = true
      // These are completed edit snapshots, not partial input. Finish them after Close.
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        // Reserve all successors now, before a reopened editor can admit newer work.
        void admit(item.draft).catch(() => {})
      }
      pending.clear()
    }
  }
}
