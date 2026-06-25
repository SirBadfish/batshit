import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

import HeaderBarIcons from './HeaderBarIcons.svelte'
import ArtifactFreshnessFixture from './ArtifactFreshnessFixture.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'

vi.mock('svelte-dnd-action', () => ({
  dndzone: () => ({
    destroy() {}
  }),
  TRIGGERS: {}
}))

describe('HeaderBarIcons accessibility labels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses fallback names for unnamed header widgets and labels the widget menu trigger', async () => {
    // @ts-expect-error test override
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }))

    render(TooltipProviderWrapper as any, {
      props: {
        component: HeaderBarIcons,
        props: {
          artifacts: [
            {
              id: 'header-1',
              name: '',
              type: 'document',
              mode: 'published',
              zone: 'header'
            },
            {
              id: 'trigger-1',
              name: 'Docs Widget',
              type: 'document',
              mode: 'published',
              zone: 'trigger'
            }
          ]
        }
      }
    })

    expect(screen.getByRole('button', { name: 'Open widget menu' })).toBeInTheDocument()

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open header widget Untitled widget' })
      ).toBeInTheDocument()
    })
  })

  it('refreshes same-id header artifacts when Settings changes their visible fields', async () => {
    // @ts-expect-error test override
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }))

    const rendered = render(ArtifactFreshnessFixture as any, {
      props: {
        component: HeaderBarIcons,
        componentProps: {
          artifacts: [
            {
              id: 'header-1',
              name: 'Old Header Name',
              type: 'html',
              icon_ref: { kind: 'lucide', id: 'file-text' },
              mode: 'published',
              zone: 'header'
            }
          ]
        }
      }
    })

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open header widget Old Header Name' })
      ).toBeInTheDocument()
    })

    await rendered.rerender({
      component: HeaderBarIcons,
      componentProps: {
        artifacts: [
          {
            id: 'header-1',
            name: 'Fresh Header Name',
            type: 'html',
            icon_ref: { kind: 'custom', iconId: 'custom-header-icon' },
            mode: 'published',
            zone: 'header'
          }
        ]
      }
    } as any)

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open header widget Fresh Header Name' })
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole('button', { name: 'Open header widget Old Header Name' })
    ).not.toBeInTheDocument()
    expect(screen.getByAltText('Fresh Header Name')).toHaveAttribute(
      'src',
      '/api/icons/custom/custom-header-icon'
    )
  })
})
