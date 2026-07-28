import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import OralAppearanceEditor from './OralAppearanceEditor.svelte'
import {
  createDefaultOralAppearanceState,
  parseOralAppearanceDefinition,
  updateOralAppearanceColor,
  updateOralAppearanceNumber
} from '$lib/goons/oralAppearance'

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
}

if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      onfinish: null
    })
  })
}

function loadDefinition() {
  return parseOralAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/oral-appearance/v1/oral-appearance-v1.json'),
        'utf8'
      )
    )
  )
}

describe('OralAppearanceEditor', () => {
  it('keeps the five package controls in contract order behind a native accordion button', async () => {
    const definition = loadDefinition()
    const { container } = render(OralAppearanceEditor, {
      definition,
      valueState: createDefaultOralAppearanceState(definition),
      onChange: vi.fn()
    })

    const trigger = screen.getByRole('button', { name: 'Oral Appearance' })
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-controls', 'facial-artwork-oral-appearance-panel')

    await fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      Array.from(
        container.querySelectorAll(
          '.oral-appearance-controls > label .batshit-goons-field-label > span'
        )
      ).map((label) => label.textContent)
    ).toEqual(['Teeth Color', 'Teeth Brightness', 'Teeth Shine', 'Gum Color', 'Tongue Color'])
    expect(screen.getByLabelText('Teeth Color')).toHaveAttribute('type', 'color')
    expect(screen.getByRole('slider', { name: 'Teeth Brightness' })).toHaveAttribute(
      'aria-valuenow',
      '1'
    )
  })

  it('shows changed state and resets every oral field to the authored package defaults', async () => {
    const definition = loadDefinition()
    const defaults = createDefaultOralAppearanceState(definition)
    const brighter = updateOralAppearanceNumber(defaults, 'teeth_brightness', 1.25)
    const changed = updateOralAppearanceColor(brighter, 'gum_color', [0.75, 0.5, 0.5])
    const onChange = vi.fn()

    render(OralAppearanceEditor, {
      definition,
      valueState: changed,
      onChange
    })

    expect(screen.getByText('Changed')).toBeInTheDocument()
    const reset = screen.getByRole('button', { name: 'Reset Oral Appearance' })
    expect(reset).toHaveAttribute('type', 'button')
    await fireEvent.click(reset)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(defaults)
  })
})
