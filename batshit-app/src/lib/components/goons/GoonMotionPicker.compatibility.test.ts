import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import GoonMotionPicker from './GoonMotionPicker.svelte'

describe('Goon Motion picker retained unverified selection', () => {
  it('keeps the saved name visible without offering an unverified new selection', async () => {
    const onChange = vi.fn()
    render(GoonMotionPicker, {
      options: [
        { name: 'old-motion', label: 'Old Motion', sourceLabel: 'Saved · unverified', disabled: true },
        { name: 'ready-motion', label: 'Ready Motion' }
      ], value: 'old-motion', onChange
    })
    const trigger = screen.getByRole('button', { name: 'Select motion' })
    expect(trigger.textContent).toContain('Old Motion')
    expect(trigger.textContent).toContain('Saved · unverified')
    expect(onChange).not.toHaveBeenCalled()
    await fireEvent.click(trigger)
    const all = await screen.findByRole('menuitem', { name: /All Motions/, hidden: true })
    await fireEvent.pointerMove(all, { pointerType: 'mouse' })
    const old = await screen.findByRole('menuitem', { name: /Old Motion/, hidden: true })
    expect(old.getAttribute('data-disabled') !== null || old.getAttribute('aria-disabled') === 'true').toBe(true)
    await fireEvent.click(old)
    expect(onChange).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('menuitem', { name: /Ready Motion/, hidden: true }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('ready-motion'))
  })
})
