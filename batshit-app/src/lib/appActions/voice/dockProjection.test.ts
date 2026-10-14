import { describe, expect, it } from 'vitest'
import { performDockAction, type ActionContext, type DockPorts } from '../owners'
import { dispatchVoiceDockQuickAction } from './dockProjection'

function dockFixture(visible: boolean, desktopActive: boolean) {
  const calls: string[] = []
  const ports = {
    visible: () => visible,
    desktopActive: () => desktopActive,
    toggleDockOrExitDesktop: () => {
      if (desktopActive) {
        calls.push('desktop_exit_requested')
        desktopActive = false
      } else {
        visible = !visible
        calls.push(visible ? 'ordinary_show_requested' : 'ordinary_hide_requested')
      }
    }
  }
  return { calls, ports }
}

describe('existing voice Dock projection', () => {
  it('shows and hides the ordinary Dock idempotently through its owner', () => {
    const { calls, ports } = dockFixture(false, false)
    expect(dispatchVoiceDockQuickAction('open_goon_dock', ports)).toBe('owner_requested')
    expect(dispatchVoiceDockQuickAction('open_goon_dock', ports)).toBe('no_op')
    expect(dispatchVoiceDockQuickAction('close_goon_dock', ports)).toBe('owner_requested')
    expect(dispatchVoiceDockQuickAction('close_goon_dock', ports)).toBe('no_op')
    expect(calls).toEqual(['ordinary_show_requested', 'ordinary_hide_requested'])
  })

  it.each([false, true])('keeps Desktop open as a no-op and close as an owner request (Dock visible %s)', visible => {
    const { calls, ports } = dockFixture(visible, true)
    expect(dispatchVoiceDockQuickAction('open_goon_dock', ports)).toBe('no_op')
    expect(calls).toEqual([])
    expect(dispatchVoiceDockQuickAction('close_goon_dock', ports)).toBe('owner_requested')
    expect(calls).toEqual(['desktop_exit_requested'])
  })

  it.each([null, 'goon.hide', 'reply.stop', 'desktop.exit', { id: 'close_goon_dock' }])(
    'rejects ids outside the two existing legacy Dock intents (%s)', id => {
      const { calls, ports } = dockFixture(true, true)
      expect(dispatchVoiceDockQuickAction(id, ports)).toBe('unsupported_action')
      expect(calls).toEqual([])
    }
  )

  it('does not hide an owner failure behind a completed result', () => {
    const { ports } = dockFixture(true, true)
    ports.toggleDockOrExitDesktop = () => { throw new Error('native owner refused') }
    expect(() => dispatchVoiceDockQuickAction('close_goon_dock', ports)).toThrow('native owner refused')
  })

  it.each(['active', 'transitioning'] as const)('does not broaden P1 ordinary Dock permission in Desktop %s', async desktop => {
    const effects: string[] = []
    const context: ActionContext = {
      sessionId: 'chat_voice', check: () => {}, effect: () => { effects.push('effect') },
      report: () => { effects.push('report') }, signal: new AbortController().signal,
      wait: async read => {
        const value = read()
        if (value === undefined) throw new Error('unmounted')
        return value
      }
    }
    const ports: DockPorts = {
      desktop: () => desktop, confirmed: () => true, visible: () => true,
      apply: () => { effects.push('visible') },
      persist: async () => { effects.push('persist'); return 'saved' }, mounted: () => true
    }
    await expect(performDockAction(false, ports, context)).rejects.toMatchObject({
      reason: desktop === 'active' ? 'desktop_mode_active' : 'desktop_transitioning'
    })
    expect(effects).toEqual([])
  })
})
