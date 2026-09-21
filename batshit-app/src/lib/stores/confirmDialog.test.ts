import { get } from 'svelte/store'
import { describe, expect, it } from 'vitest'
import {
  activeConfirmDialog,
  confirmDialog,
  confirmDialogWithCheckbox,
  resolveConfirmDialog,
  setConfirmDialogChecked
} from './confirmDialog'

describe('confirmDialog checkbox (2026-09-19)', () => {
  it('carries the checkbox answer with the confirmation, and a cancel never reports it checked', async () => {
    const pending = confirmDialogWithCheckbox({
      title: 'Delete Bob?',
      checkbox: { label: 'Also delete its 5 chats', checked: true }
    })
    const request = get(activeConfirmDialog)!
    expect(request.checkbox?.label).toBe('Also delete its 5 chats')
    expect(request.checked).toBe(true)

    setConfirmDialogChecked(request.id, false)
    expect(get(activeConfirmDialog)?.checked).toBe(false)
    setConfirmDialogChecked(request.id, true)
    resolveConfirmDialog(request.id, true)
    await expect(pending).resolves.toEqual({ confirmed: true, checked: true })

    const cancelled = confirmDialogWithCheckbox({
      title: 'Delete Bob?',
      checkbox: { label: 'Also delete its 5 chats', checked: true }
    })
    resolveConfirmDialog(get(activeConfirmDialog)!.id, false)
    await expect(cancelled).resolves.toEqual({ confirmed: false, checked: false })
  })

  it('keeps the plain yes/no shape for every existing caller, with no checkbox shown', async () => {
    const pending = confirmDialog({ title: 'Sure?' })
    const request = get(activeConfirmDialog)!
    expect(request.checkbox).toBeNull()
    setConfirmDialogChecked(request.id, true)
    expect(get(activeConfirmDialog)?.checked).toBe(false)
    resolveConfirmDialog(request.id, true)
    await expect(pending).resolves.toBe(true)
  })
})
