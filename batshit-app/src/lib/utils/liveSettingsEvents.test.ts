import { describe, expect, it, vi } from 'vitest'
import {
  LIVE_SETTINGS_EVENTS,
  dispatchSlashCommandsUpdated
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
})
