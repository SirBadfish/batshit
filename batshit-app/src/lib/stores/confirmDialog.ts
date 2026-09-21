import { get, writable } from 'svelte/store'

export type ConfirmDialogTone = 'default' | 'destructive'

/**
 * An optional checkbox under the description (2026-09-19; first use: "Also delete its chats"
 * on the delete-agent dialog). The answer travels with the confirmation, so a caller reads
 * one result instead of racing a separate store.
 */
export interface ConfirmDialogCheckbox {
  label: string
  /** One quiet line under the label, for a caveat the user should read before confirming. */
  note?: string
  /** Initial state; defaults to unchecked. */
  checked?: boolean
}

export interface ConfirmDialogOptions {
  title: string
  description?: string | string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
  checkbox?: ConfirmDialogCheckbox
}

export interface ConfirmDialogResult {
  confirmed: boolean
  /** The checkbox's final state; `false` when the dialog had no checkbox or was cancelled. */
  checked: boolean
}

export interface ActiveConfirmDialog {
  id: number
  title: string
  description: string | string[]
  descriptionLines: string[]
  confirmLabel: string
  cancelLabel: string
  tone: ConfirmDialogTone
  checkbox: ConfirmDialogCheckbox | null
  checked: boolean
  resolve: (result: ConfirmDialogResult) => void
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

function enqueueConfirmDialog(options: ConfirmDialogOptions): Promise<ConfirmDialogResult> {
  if (typeof window === 'undefined') return Promise.resolve({ confirmed: false, checked: false })

  return new Promise<ConfirmDialogResult>((resolve) => {
    const request: ActiveConfirmDialog = {
      id: nextConfirmDialogId++,
      title: options.title,
      description: options.description ?? '',
      descriptionLines: normalizeDescription(options.description),
      confirmLabel: options.confirmLabel ?? 'Confirm',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      tone: options.tone ?? 'default',
      checkbox: options.checkbox ?? null,
      checked: options.checkbox?.checked === true,
      resolve
    }

    if (get(activeConfirmDialog)) {
      confirmDialogQueue.push(request)
    } else {
      activeConfirmDialog.set(request)
    }
  })
}

/** Yes/no. The long-standing shape every caller uses; a checkbox passed here is still shown. */
export function confirmDialog(options: string | ConfirmDialogOptions): Promise<boolean> {
  const normalized =
    typeof options === 'string' ? { title: 'Are you sure?', description: options } : options
  return enqueueConfirmDialog(normalized).then((result) => result.confirmed)
}

/** Yes/no plus the checkbox's answer, for dialogs that carry one. */
export function confirmDialogWithCheckbox(
  options: ConfirmDialogOptions & { checkbox: ConfirmDialogCheckbox }
): Promise<ConfirmDialogResult> {
  return enqueueConfirmDialog(options)
}

export function setConfirmDialogChecked(id: number, checked: boolean) {
  const current = get(activeConfirmDialog)
  if (!current || current.id !== id || !current.checkbox) return
  activeConfirmDialog.set({ ...current, checked })
}

export function resolveConfirmDialog(id: number, confirmed: boolean) {
  const current = get(activeConfirmDialog)
  if (!current || current.id !== id) return

  current.resolve({ confirmed, checked: confirmed && current.checked })
  activeConfirmDialog.set(null)
  showNextConfirmDialog()
}
