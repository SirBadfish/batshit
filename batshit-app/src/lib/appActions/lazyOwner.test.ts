import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import LazySettingsPanelContent from '$lib/components/settings/LazySettingsPanelContent.svelte'
import Fixture from './SettingsOwner.fixture.svelte'
import type { LazyPanelHandle } from './owners'

describe('App Actions lazy completion follows production mount and failure', () => {
  it('cannot claim a loaded module is a mounted target before the actual DOM connects', async () => {
    let resolve!: (value: { default: typeof Fixture }) => void
    let handle: LazyPanelHandle | null = null
    render(LazySettingsPanelContent, { props: { active: true, label: 'Fixture',
      loader: () => new Promise(done => { resolve = done }), onAppActionHandle: value => { handle = value } } })
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    expect(handle!.readAppActionState()).toMatchObject({ mounted: false, error: null })
    resolve({ default: Fixture })
    await screen.findByTestId('settings-owner-fixture')
    await waitFor(() => expect(handle!.readAppActionState().mounted).toBe(true))
    expect(handle!.readAppActionState().panel!.readAppActionState()).toMatchObject({ entityId: null, busy: false })
  })
  it('exposes load failure instead of mounted success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let handle: LazyPanelHandle | null = null
    render(LazySettingsPanelContent, { props: { active: true, label: 'Fixture',
      loader: async () => { throw new Error('fixture chunk unavailable') }, onAppActionHandle: value => { handle = value } } })
    await screen.findByText('Could not load Fixture settings.')
    expect(handle!.readAppActionState()).toMatchObject({ mounted: false, error: 'fixture chunk unavailable', panel: null })
  })
  it('unregisters on unmount and cannot mount a late chunk into the retired owner', async () => {
    let resolve!: (value: { default: typeof Fixture }) => void
    const callback = vi.fn()
    const { unmount } = render(LazySettingsPanelContent, { props: { active: true, label: 'Fixture',
      loader: () => new Promise(done => { resolve = done }), onAppActionHandle: callback } })
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    unmount()
    expect(callback).toHaveBeenLastCalledWith(null)
    resolve({ default: Fixture })
    await Promise.resolve()
    expect(screen.queryByTestId('settings-owner-fixture')).toBeNull()
  })
})
