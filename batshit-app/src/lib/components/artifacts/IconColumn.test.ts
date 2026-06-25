import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

import IconColumn from './IconColumn.svelte'
import ArtifactFreshnessFixture from './ArtifactFreshnessFixture.svelte'
import TooltipProviderWrapper from '$lib/test-utils/TooltipProviderWrapper.svelte'

vi.mock('svelte-dnd-action', () => ({
  dndzone: () => ({
    destroy() {}
  }),
  TRIGGERS: {}
}))

describe('IconColumn accessibility labels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('labels system icons and gives unnamed panel widgets a fallback label', async () => {
    // @ts-expect-error test override
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }))

    render(TooltipProviderWrapper as any, {
      props: {
        component: IconColumn,
        props: {
          systemIcons: [
            {
              id: 'execution-viewer',
              title: 'Execution Viewer',
              icon: 'file-text',
              onClick: vi.fn()
            }
          ],
          artifacts: [
            {
              id: 'artifact-1',
              name: '',
              type: 'document',
              ai_enabled: false,
              mode: 'published'
            }
          ]
        }
      }
    })

    expect(screen.getByRole('button', { name: 'Execution Viewer' })).toBeInTheDocument()

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open panel widget Untitled panel widget' })
      ).toBeInTheDocument()
    })
  })

  it('marks the open panel widget as active', async () => {
    // @ts-expect-error test override
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }))

    render(TooltipProviderWrapper as any, {
      props: {
        component: IconColumn,
        props: {
          activeArtifactId: 'artifact-1',
          panelOpen: true,
          artifacts: [
            {
              id: 'artifact-1',
              name: 'ComfyUI Z Turbo',
              type: 'html',
              ai_enabled: false,
              mode: 'published'
            }
          ]
        }
      }
    })

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Close panel widget ComfyUI Z Turbo' })
      expect(button).toHaveAttribute('aria-pressed', 'true')
      expect(button).toHaveClass('is-active')
    })
  })

  it('refreshes same-id panel artifacts when Settings changes their visible fields', async () => {
    // @ts-expect-error test override
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({})
    }))

    const rendered = render(ArtifactFreshnessFixture as any, {
      props: {
        component: IconColumn,
        componentProps: {
          artifacts: [
            {
              id: 'artifact-1',
              name: 'Old Panel Name',
              type: 'html',
              icon_ref: { kind: 'lucide', id: 'file-text' },
              ai_enabled: false,
              mode: 'published'
            }
          ]
        }
      }
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open panel widget Old Panel Name' })).toBeInTheDocument()
    })

    await rendered.rerender({
      component: IconColumn,
      componentProps: {
        artifacts: [
          {
            id: 'artifact-1',
            name: 'Fresh Panel Name',
            type: 'html',
            icon_ref: { kind: 'custom', iconId: 'custom-panel-icon' },
            ai_enabled: false,
            mode: 'published'
          }
        ]
      }
    } as any)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open panel widget Fresh Panel Name' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Open panel widget Old Panel Name' })).not.toBeInTheDocument()
    expect(screen.getByAltText('Fresh Panel Name')).toHaveAttribute(
      'src',
      '/api/icons/custom/custom-panel-icon'
    )
  })
})
