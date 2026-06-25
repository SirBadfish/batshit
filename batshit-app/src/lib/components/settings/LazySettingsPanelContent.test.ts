import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

import LazySettingsPanelContent from './LazySettingsPanelContent.svelte'
import LazySettingsPanelContentFixture from './LazySettingsPanelContent.fixture.svelte'

describe('LazySettingsPanelContent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not load a panel before the tab becomes active', async () => {
    const loader = vi.fn(async () => ({ default: LazySettingsPanelContentFixture }))

    render(LazySettingsPanelContent, {
      props: {
        active: false,
        label: 'Agents',
        loader,
        panelProps: { name: 'Agents' }
      }
    })

    await Promise.resolve()

    expect(loader).not.toHaveBeenCalled()
    expect(screen.queryByText('Loaded Agents')).not.toBeInTheDocument()
  })

  it('loads and renders the panel when active', async () => {
    const onLoaded = vi.fn()
    const loader = vi.fn(async () => ({ default: LazySettingsPanelContentFixture }))

    render(LazySettingsPanelContent, {
      props: {
        active: true,
        label: 'Agents',
        loader,
        panelProps: { name: 'Agents', onLoaded }
      }
    })

    await screen.findByText('Loaded Agents')

    expect(loader).toHaveBeenCalledTimes(1)
    expect(onLoaded).toHaveBeenCalledWith('Agents')
  })

  it('shows a loud loading error and can retry', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce({ default: LazySettingsPanelContentFixture })

    render(LazySettingsPanelContent, {
      props: {
        active: true,
        label: 'Agents',
        loader,
        panelProps: { name: 'Agents' }
      }
    })

    await screen.findByText('Could not load Agents settings.')
    expect(screen.getByText('chunk missing')).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByText('Loaded Agents')
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
  })
})
