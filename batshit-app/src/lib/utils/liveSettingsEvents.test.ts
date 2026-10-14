import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LIVE_SETTINGS_EVENTS,
  dispatchDesktopGoonPreferencesUpdated,
  dispatchSlashCommandsUpdated,
  resolveServerClipStateSource
} from './liveSettingsEvents'

describe('live settings events', () => {
  it('dispatches slash command updates with source and command details', () => {
    const listener = vi.fn()
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, listener)

    dispatchSlashCommandsUpdated({
      source: 'agent-access',
      commandId: 'cmd_cli_tool_creator'
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      type: LIVE_SETTINGS_EVENTS.slashCommandsUpdated,
      detail: {
        source: 'agent-access',
        commandId: 'cmd_cli_tool_creator'
      }
    })

    window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, listener)
  })

  it('dispatches Desktop Goon preferences for mounted native consumers', () => {
    const listener = vi.fn()
    window.addEventListener(LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated, listener)

    dispatchDesktopGoonPreferencesUpdated({
      source: 'settings',
      preferences: {
        fullHeight: true,
        normalizedWidth: 0.35,
        stayOnTop: true,
        clickThrough: false,
        controlsShortcut: 'CommandOrControl+Shift+G',
        workspace: 'current-workspace'
      }
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      type: LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated,
      detail: {
        source: 'settings',
        preferences: {
          stayOnTop: true,
          clickThrough: false
        }
      }
    })

    window.removeEventListener(LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated, listener)
  })
})

describe('BL-505: the server\u2019s clip_state_changed source', () => {
  it('keeps an artifact share and a spent countdown, and reads anything else as runtime', () => {
    expect(resolveServerClipStateSource('artifact-share')).toBe('artifact-share')
    expect(resolveServerClipStateSource('countdown')).toBe('countdown')
    expect(resolveServerClipStateSource('clip-manager')).toBe('runtime')
    expect(resolveServerClipStateSource(undefined)).toBe('runtime')
  })

  it('the chat page hands the server\u2019s source on through it', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/routes/+page.svelte'), 'utf8')
    expect(page).toContain(
      "\n    } else if (data.type === 'clip_state_changed') {\n      dispatchSessionClipStateChanged({\n"
    )
    expect(page).toContain('\n        source: resolveServerClipStateSource(data.source)\n')
  })
})
