import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import SocketEyeContactEditor from './SocketEyeContactEditor.svelte'
import { DEFAULT_SOCKET_EYE_CONTACT_SETTINGS } from '$lib/goons/socketEyeContact'

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

describe('SocketEyeContactEditor', () => {
  it('exposes the five socket-eye behavior settings and no retired globe tuning', () => {
    render(SocketEyeContactEditor, {
      value: { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS },
      onChange: vi.fn()
    })

    const enabledSwitch = screen.getByRole('switch', { name: 'Enable Eye Contact' })
    expect(enabledSwitch).toBeChecked()
    expect(enabledSwitch.parentElement).toHaveClass('is-inline-status')
    expect(screen.getAllByRole('slider').map((slider) => slider.getAttribute('aria-label'))).toEqual([
      'Strength',
      'Gaze Convergence',
      'Head Follow',
      'Response'
    ])
    expect(screen.queryByText(/sclera fit/i)).not.toBeInTheDocument()
  })

  it('emits strict socket settings for switch and slider changes', async () => {
    const onChange = vi.fn()
    render(SocketEyeContactEditor, {
      value: { ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS },
      onChange
    })

    await fireEvent.click(screen.getByRole('switch', { name: 'Enable Eye Contact' }))
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
      enabled: false
    })

    await fireEvent.keyDown(screen.getByRole('slider', { name: 'Response' }), {
      key: 'ArrowLeft'
    })
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
      response: 0.49
    })

    await fireEvent.keyDown(screen.getByRole('slider', { name: 'Gaze Convergence' }), {
      key: 'ArrowRight'
    })
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
      convergence: 0.01
    })
  })
})
