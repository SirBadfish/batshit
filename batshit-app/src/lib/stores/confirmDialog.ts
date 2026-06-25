import { get, writable } from 'svelte/store'

export type ConfirmDialogTone = 'default' | 'destructive'

export interface ConfirmDialogOptions {
  title: string
  description?: string | string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
}

export interface ActiveConfirmDialog extends Required<ConfirmDialogOptions> {
  id: number
  descriptionLines: string[]
  resolve: (confirmed: boolean) => void
}

let nextConfirmDialogId = 1
const confirmDialogQueue: ActiveConfirmDialog[] = []

export const activeConfirmDialog = writable<ActiveConfirmDialog | null>(null)

function showNextConfirmDialog() {
  const next = confirmDialogQueue.shift() ?? null
  if (!next) return

  queueMicrotask(() => {
    if (!get(activeConfirmDialog)) {
      activeConfirmDialog.set(next)
    } else {
      confirmDialogQueue.unshift(next)
    }
  })
}

function normalizeDescription(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return value.split('\n')
}

export function confirmDialog(options: string | ConfirmDialogOptions) {
  if (typeof window === 'undefined') return Promise.resolve(false)

  const normalized =
    typeof options === 'string'
      ? { title: 'Are you sure?', description: options }
      : options

  return new Promise<boolean>((resolve) => {
    const request: ActiveConfirmDialog = {
      id: nextConfirmDialogId++,
      title: normalized.title,
      description: normalized.description ?? '',
      descriptionLines: normalizeDescription(normalized.description),
      confirmLabel: normalized.confirmLabel ?? 'Confirm',
      cancelLabel: normalized.cancelLabel ?? 'Cancel',
      tone: normalized.tone ?? 'default',
      resolve
    }

    if (get(activeConfirmDialog)) {
      confirmDialogQueue.push(request)
    } else {
      activeConfirmDialog.set(request)
    }
  })
}

export function resolveConfirmDialog(id: number, confirmed: boolean) {
  const current = get(activeConfirmDialog)
  if (!current || current.id !== id) return

  current.resolve(confirmed)
  activeConfirmDialog.set(null)
  showNextConfirmDialog()
}
