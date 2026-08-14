import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import { HAIR_MOTION_PAINT_CONTRACT } from '$lib/goons/hairMotionPaint'
import HairMotionPaintOverlay from './HairMotionPaintOverlay.svelte'

describe('HairMotionPaintOverlay', () => {
  it('uses one paint selection and keeps visibility, cleanup, and exit actions distinct', async () => {
    const onSetGoonVisible = vi.fn()
    const onSetMeshVisible = vi.fn()
    const onSave = vi.fn()

    render(HairMotionPaintOverlay, {
      topology: {
        meshes: [
          { meshNode: 'Hair_Main', triangleCount: 12, vertexCount: 36 },
          { meshNode: 'Hair_Bun', triangleCount: 8, vertexCount: 24 }
        ]
      },
      initialPaint: {
        contract: HAIR_MOTION_PAINT_CONTRACT,
        regions: [
          {
            id: 'old-left',
            label: 'Left strand',
            enabled: true,
            meshes: [
              { meshNode: 'Hair_Main', triangleCount: 12, triangleRanges: [[1, 2]] }
            ]
          },
          {
            id: 'old-right',
            label: 'Right strand',
            enabled: true,
            meshes: [
              { meshNode: 'Hair_Main', triangleCount: 12, triangleRanges: [[6, 6]] }
            ]
          }
        ]
      },
      onPreview: vi.fn(),
      onPick: vi.fn().mockReturnValue(null),
      onSetGoonVisible,
      onSetMeshVisible,
      onSave,
      onCancel: vi.fn()
    })

    expect(screen.queryByLabelText('Active motion area')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Motion area name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear all painted motion' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel painting' })).toHaveTextContent('Cancel')
    expect(screen.getByRole('button', { name: 'Apply painted motion' })).toHaveTextContent('Done')

    await fireEvent.click(screen.getByRole('button', { name: 'Paint visibility' }))
    const goonVisibility = screen.getByRole('menuitemcheckbox', { name: 'Goon' })
    expect(goonVisibility).toHaveAttribute('aria-checked', 'true')
    await fireEvent.click(goonVisibility)
    expect(onSetGoonVisible).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole('button', { name: 'Paint visibility, 1 hidden' })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Paint visibility, 1 hidden' }))
    const mainHairVisibility = screen.getByRole('menuitemcheckbox', { name: 'Hair_Main' })
    expect(mainHairVisibility).toHaveAttribute('aria-checked', 'true')
    await fireEvent.click(mainHairVisibility)
    expect(onSetMeshVisible).toHaveBeenLastCalledWith('Hair_Main', false)
    expect(screen.getByRole('button', { name: 'Paint visibility, 2 hidden' })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Apply painted motion' }))
    expect(onSave).toHaveBeenCalledWith({
      contract: HAIR_MOTION_PAINT_CONTRACT,
      regions: [
        {
          id: 'paint-region-001',
          label: 'Custom Motion',
          enabled: true,
          meshes: [
            { meshNode: 'Hair_Main', triangleCount: 12, triangleRanges: [[1, 2], [6, 6]] }
          ]
        }
      ]
    })
  })
})
