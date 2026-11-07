import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import GoonOperationOverlay, {
  formatGoonOperationElapsed
} from './GoonOperationOverlay.svelte'
import {
  recipeBuildCanCancel,
  recipeWorkflowProgressPhase
} from './recipe/recipeWorkflowOperation'

describe('GoonOperationOverlay', () => {
  it('uses modal semantics, blocks Escape, and exposes only a real cancel action', async () => {
    const onCancel = vi.fn()
    const outerEscape = vi.fn()
    document.addEventListener('keydown', outerEscape)

    const view = render(GoonOperationOverlay, {
      operation: {
        title: 'Saving Goon',
        phase: 'Baking the Goon model',
        onCancel
      }
    })

    const dialog = await screen.findByRole('dialog', { name: 'Saving Goon' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(document.querySelector('.bs-dialog-overlay')).toBeInTheDocument()
    expect(screen.getByText('Elapsed: 0s')).toBeInTheDocument()

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(outerEscape).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Saving Goon' })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    await view.rerender({
      operation: {
        title: 'Saving Goon',
        phase: 'Saving the Goon',
        detail: 'The final server commit is in progress and cannot be canceled.'
      }
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    })

    document.removeEventListener('keydown', outerEscape)
  })

  it('formats the elapsed timer without implying a progress percentage', () => {
    expect(formatGoonOperationElapsed(0)).toBe('0s')
    expect(formatGoonOperationElapsed(9.9)).toBe('9s')
    expect(formatGoonOperationElapsed(65)).toBe('1:05')
  })

  it('keeps elapsed time across real phase changes and removes the modal when work ends', async () => {
    const view = render(GoonOperationOverlay, {
      operation: {
        title: 'Saving Goon',
        phase: 'Baking the Goon model'
      }
    })
    expect(screen.getByText('Elapsed: 0s')).toBeInTheDocument()

    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(screen.getByText('Elapsed: 1s')).toBeInTheDocument()

    await view.rerender({
      operation: {
        title: 'Saving Goon',
        phase: 'Saving the Goon'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(screen.getByText('Elapsed: 2s')).toBeInTheDocument()

    await view.rerender({ operation: null })
    await waitFor(() => {
      expect(screen.queryByTestId('goon-operation-overlay')).not.toBeInTheDocument()
    })
    view.unmount()
  })
})

describe('Recipe Goon operation projection', () => {
  it('allows cancellation before commit and removes it for commit, completion, and cancellation settlement', () => {
    expect(recipeBuildCanCancel('rewriting-model', true, false)).toBe(true)
    expect(recipeBuildCanCancel('committing', true, false)).toBe(false)
    expect(recipeBuildCanCancel('complete', true, false)).toBe(false)
    expect(recipeBuildCanCancel('rewriting-model', true, true)).toBe(false)
    expect(recipeBuildCanCancel('rewriting-model', false, false)).toBe(false)
  })

  it('reports the actual workflow stage in plain language', () => {
    expect(recipeWorkflowProgressPhase('rewriting-model')).toBe('Baking the Goon model')
    expect(recipeWorkflowProgressPhase('committing')).toBe('Saving the Goon')
    expect(recipeWorkflowProgressPhase(null)).toBeNull()
  })
})
