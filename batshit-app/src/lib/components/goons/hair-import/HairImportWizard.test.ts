import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import HairImportWizard from './HairImportWizard.svelte'
import type { HairImportInspection, HairImportProposalSet } from './hairImportUiState'

function inspection(): HairImportInspection {
  return {
    sessionId: 'session-hair-01',
    previewGeometryUrl: '/uploads/goon_hair_imports/inspection-preview.glb',
    sourceModeLabel: 'Generic finished mesh',
    sourceSummary: 'Two objects were inspected from ordinary polygon geometry.',
    objects: [
      {
        id: 'hair',
        name: 'Hair clumps',
        triangleCount: 12_500,
        materialCount: 2,
        recommendedHair: true,
        reason: 'Open clumps surround the scalp.'
      },
      {
        id: 'head',
        name: 'Reference head',
        triangleCount: 5_000,
        materialCount: 1,
        recommendedHair: false,
        reason: 'Closed reference geometry is not Hair.'
      }
    ],
    proposedTransform: {
      move: { x: 0, y: 0.02, z: 0 },
      rotate: { x: 0, y: 0, z: 0 },
      uniformScale: 1.1,
      axisScale: { x: 1, y: 1.05, z: 1 }
    },
    initialTransform: {
      move: { x: 0, y: 0.02, z: 0 },
      rotate: { x: 0, y: 0, z: 0 },
      uniformScale: 1.1,
      axisScale: { x: 1, y: 1.05, z: 1 }
    },
    notices: ['Reference geometry is proposed for removal.']
  }
}

function proposals(): HairImportProposalSet {
  return {
    material: {
      title: 'Neutral Hair material',
      summary: 'Generate neutral value and Highlight textures for recoloring.',
      details: ['Keep roughness independent from color.']
    },
    follower: {
      title: 'Appearance following',
      summary: 'Follow the scalp strongly at roots and less toward tips.',
      details: ['Keep the roots attached across supported Appearance changes.']
    },
    physics: {
      title: 'Root-weighted motion',
      summary: 'Propose clump chains and shared body colliders.',
      details: ['Motion remains editable before save.']
    },
    motionReview: {
      anchoredLength: 0.5,
      weightCurve: 'root-to-tip-smoothstep/v1',
      defaultIntensity: 1,
      regions: [
        {
          id: 'hair:region-001',
          meshNode: 'Hair clumps',
          label: 'Front strands',
          moving: true,
          recommendedMoving: true,
          supportsMotion: true,
          lengthMeters: 0.24,
          vertexCount: 2400,
          explanation: 'Batshit proposed motion because these strands hang below their roots.'
        }
      ]
    },
    validationSummary: 'Geometry and ownership checks are ready for visual review.',
    receipt: {
      kept: ['Hair clumps'],
      removed: ['Reference head'],
      generated: ['Canonical GLB', 'Neutral textures', 'Fit receipt']
    }
  }
}

function callbacks() {
  return {
    onInspect: vi.fn().mockResolvedValue(inspection()),
    onPreviewSelectionChange: vi.fn(),
    onPreviewTransformChange: vi.fn(),
    onReturnToFit: vi.fn().mockResolvedValue(undefined),
    onBuildPreview: vi.fn().mockResolvedValue(proposals()),
    onEditMotionPaint: vi.fn().mockResolvedValue(null),
    onSetMotionMap: vi.fn().mockResolvedValue(undefined),
    onFinalize: vi.fn().mockResolvedValue({ assetId: 'imported-hair-1' }),
    onCancel: vi.fn().mockResolvedValue(undefined),
    onComplete: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn()
  }
}

async function reachFinalization() {
  await chooseAndInspect()
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Continue to Physics' }))
  await screen.findByText('Hair Physics')
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByText('Review Your Hair Style')
}

async function chooseAndInspect() {
  const input = screen.getByLabelText('Choose Hair OBJ or GLB with optional AHS calibration')
  const file = new File(['o Hair\nv 0 0 0\n'], 'finished-hair.obj', {
    type: 'text/plain'
  })
  await fireEvent.change(input, { target: { files: [file] } })
  await fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview' }))
  await screen.findByText('Keep Only the Hair Objects')
  return file
}

describe('HairImportWizard', () => {
  it('starts from the file selected by the catalog Import Hair button', async () => {
    const props = callbacks()
    const initialFile = new File(['o Hair\nv 0 0 0\n'], 'catalog-hair.obj', {
      type: 'text/plain'
    })
    render(HairImportWizard, { ...props, initialFile })

    await screen.findByText('Keep Only the Hair Objects')
    expect(screen.queryByText(/Uncheck a row and watch that piece disappear/i)).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'About Keep Only the Hair Objects' }))
    expect(
      await screen.findByText(/Uncheck a row and watch that piece disappear/i)
    ).toBeInTheDocument()
    expect(props.onInspect).toHaveBeenCalledWith(initialFile, null)
    expect(props.onInspect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /Choose .*OBJ or GLB/ })).toBeNull()
  })

  it('keeps the catalog-selected file as the only choice when automatic inspection fails', async () => {
    const props = callbacks()
    props.onInspect.mockRejectedValueOnce(new Error('Stored Hair import job is malformed.'))
    const initialFile = new File(['o Hair\nv 0 0 0\n'], 'catalog-hair.obj', {
      type: 'text/plain'
    })
    render(HairImportWizard, { ...props, initialFile })

    expect(await screen.findByText('Stored Hair import job is malformed.')).toBeInTheDocument()
    expect(screen.getByText('catalog-hair.obj')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Choose .*OBJ or GLB/ })).toBeNull()
    expect(
      screen.queryByLabelText('Choose Hair OBJ or GLB with optional AHS calibration')
    ).toBeNull()
  })

  it('reopens a refit at the last saved transform without inspecting another file', async () => {
    const props = callbacks()
    const savedInspection = inspection()
    savedInspection.initialTransform = {
      move: { x: 0, y: 0.19, z: 0 },
      rotate: { x: 0, y: -90, z: 0 },
      uniformScale: 0.27,
      axisScale: { x: 1.15, y: 1.15, z: 1.01 }
    }
    savedInspection.notices = [
      'Source materials were inventoried and will be replaced by Batshit neutral material ownership.',
      'Reference geometry is proposed for removal.'
    ]
    render(HairImportWizard, {
      ...props,
      mode: 'refit',
      initialInspection: savedInspection,
      initialFileSelection: {
        name: 'Black Bun.glb',
        size: 3_000_000,
        type: 'model/gltf-binary'
      }
    })

    expect(screen.getByRole('heading', { name: 'Edit Hair Style' })).toBeInTheDocument()
    expect(screen.queryByText('New immutable revision')).not.toBeInTheDocument()
    expect(screen.queryByText(/This creates a new copy of your hairstyle/i)).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'About Edit Hair Style' }))
    expect(await screen.findByText(/This creates a new copy of your hairstyle/i)).toBeInTheDocument()
    expect(screen.getByText('Keep Only the Hair Objects')).toBeInTheDocument()
    expect(screen.queryByText(savedInspection.sourceSummary)).not.toBeInTheDocument()
    expect(screen.queryByText('Open clumps surround the scalp.')).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Source materials were inventoried and will be replaced by Batshit neutral material ownership.'
      )
    ).not.toBeInTheDocument()
    expect(screen.getByText('Reference geometry is proposed for removal.')).toBeInTheDocument()
    expect(screen.queryByText('Choose')).not.toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: 'Hair import: Inspect' })
    expect(progress).toHaveAttribute('aria-valuenow', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '4')
    expect(props.onInspect).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Fit the Live Hair Preview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset Fit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Fit the Live Hair Preview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Move' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Rotate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Scale' })).toBeInTheDocument()
    expect(screen.queryByText('Centimeter offsets from the starting fit.')).not.toBeInTheDocument()
    expect(screen.queryByText('Degrees around each axis.')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Uniform scale sets size. X, Y, and Z make bounded fit corrections.')
    ).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'About Move' }))
    expect(await screen.findByText('Centimeter offsets from the starting fit.')).toBeInTheDocument()
    expect(screen.getByLabelText('Rotate Y')).toHaveValue(-90)
    expect(screen.getByLabelText('Uniform Scale')).toHaveValue(0.27)
    expect(screen.getByLabelText('Move Y offset in centimeters')).toHaveValue(17)
  })

  it('moves from Fit through Physics to a clean final review, then saves and closes', async () => {
    const props = callbacks()
    render(HairImportWizard, props)

    const file = await chooseAndInspect()
    expect(props.onInspect).toHaveBeenCalledWith(file, null)
    expect(screen.getByRole('checkbox', { name: 'Keep Hair clumps' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Keep Reference head' })).not.toBeChecked()

    await fireEvent.click(screen.getByRole('button', { name: 'Show only Hair clumps' }))
    expect(props.onPreviewSelectionChange).toHaveBeenLastCalledWith(['hair'], 'hair')
    await fireEvent.click(screen.getByRole('button', { name: 'Show all included Hair objects' }))
    expect(props.onPreviewSelectionChange).toHaveBeenLastCalledWith(['hair'], null)

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Fit the Live Hair Preview')).toBeInTheDocument()
    await fireEvent.input(screen.getByLabelText('Move X offset in centimeters'), {
      target: { value: '9' }
    })
    expect(props.onPreviewTransformChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ move: { x: 0.09, y: 0.02, z: 0 } })
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to Physics' }))

    await screen.findByText('Hair Physics')
    expect(screen.queryByText('What Batshit generated automatically')).not.toBeInTheDocument()
    expect(screen.getByText('Automatic Physics')).toBeInTheDocument()
    expect(screen.getByText('1 moving sections found')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Paint Motion Areas' })).not.toBeInTheDocument()
    expect(props.onSetMotionMap).toHaveBeenLastCalledWith(true, expect.any(Object))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(screen.queryByText('Viewing angles')).not.toBeInTheDocument()
    expect(screen.queryByText('Appearance risk states')).not.toBeInTheDocument()
    expect(props.onBuildPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-hair-01',
        selectedObjectIds: ['hair'],
        transform: expect.objectContaining({
          move: { x: 0.09, y: 0.02, z: 0 }
        })
      })
    )

    await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByText('Fit the Live Hair Preview')
    expect(props.onReturnToFit).toHaveBeenCalledWith(
      inspection(),
      expect.objectContaining({ selectedObjectIds: ['hair'] })
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to Physics' }))
    await screen.findByText('Hair Physics')
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Review Your Hair Style')).toBeInTheDocument()
    expect(
      screen.getByText(/Orbit around the Goon and make sure the hairstyle looks right/i)
    ).toBeInTheDocument()
    expect(screen.queryByText('Visible import receipt')).not.toBeInTheDocument()
    expect(props.onSetMotionMap).toHaveBeenLastCalledWith(false, expect.any(Object))

    await fireEvent.click(screen.getByRole('button', { name: 'Save Hair Style' }))
    await waitFor(() => expect(props.onFinalize).toHaveBeenCalledTimes(1))
    expect(props.onFinalize).toHaveBeenCalledWith({ sessionId: 'session-hair-01' })
    expect(props.onComplete).toHaveBeenCalledWith({
      assetId: 'imported-hair-1'
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('defaults to Automatic Physics and reveals painting controls only in Custom Paint', async () => {
    const props = callbacks()
    const proposal = proposals()
    proposal.motionReview.regions.push({
      id: 'hair:region-002',
      meshNode: 'Hair clumps',
      label: 'Tiny decorative detail',
      moving: false,
      recommendedMoving: false,
      supportsMotion: false,
      lengthMeters: 0.003,
      vertexCount: 12,
      explanation:
        'Batshit kept this tiny section anchored because it is too short to support a stable motion chain.'
    })
    props.onBuildPreview.mockResolvedValue(proposal)
    render(HairImportWizard, props)

    await chooseAndInspect()
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to Physics' }))

    expect(await screen.findByText('Automatic Physics')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Paint Motion Areas' })).not.toBeInTheDocument()
    expect(screen.queryByText(/One motion area can include several disconnected strands/)).not.toBeInTheDocument()
    expect(props.onSetMotionMap).toHaveBeenLastCalledWith(true, expect.any(Object))
    expect(screen.queryByText('Tiny decorative detail')).not.toBeInTheDocument()

    await fireEvent.click(screen.getByRole('radio', { name: 'Custom Paint' }))
    expect(await screen.findByRole('button', { name: 'Paint Motion Areas' })).toBeInTheDocument()
    expect(screen.getByText(/paint roughly its outer half/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('replaces Automatic Physics with one custom painted selection', async () => {
    const props = callbacks()
    props.onEditMotionPaint.mockResolvedValue({
      contract: 'hair-motion-paint/v1',
      regions: [
        {
          id: 'paint-region-001',
          label: 'Custom Motion',
          enabled: true,
          meshes: [
            { meshNode: 'Hair clumps', triangleCount: 12, triangleRanges: [[5, 8]] }
          ]
        }
      ]
    })
    render(HairImportWizard, props)

    await chooseAndInspect()
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to Physics' }))
    await screen.findByText('Automatic Physics')
    await fireEvent.click(screen.getByRole('radio', { name: 'Custom Paint' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Paint Motion Areas' }))

    expect(await screen.findByRole('button', { name: 'Edit Painted Motion' })).toBeInTheDocument()
    expect(screen.getByText('4 triangles')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
    expect(props.onBuildPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        motionPaint: expect.objectContaining({ contract: 'hair-motion-paint/v1' }),
        motionRegionSelections: null
      })
    )
  })

  it('keeps a failed step visible, retries it, and explicitly cleans up on cancel', async () => {
    const props = callbacks()
    props.onInspect.mockRejectedValueOnce(
      new Error('OBJ inspection exceeded the safe geometry budget.')
    )
    render(HairImportWizard, props)

    const input = screen.getByLabelText('Choose Hair OBJ or GLB with optional AHS calibration')
    const file = new File(['bad'], 'too-large.obj', { type: 'text/plain' })
    await fireEvent.change(input, { target: { files: [file] } })
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OBJ inspection exceeded the safe geometry budget.'
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Keep Only the Hair Objects')
    expect(props.onInspect).toHaveBeenCalledTimes(2)

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel Hair import' }))
    await waitFor(() => {
      expect(props.onCancel).toHaveBeenCalledWith('session-hair-01')
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('retries editor mounting without publishing a second immutable revision', async () => {
    const props = callbacks()
    props.onComplete
      .mockRejectedValueOnce(new Error('The Hair catalog refresh failed.'))
      .mockResolvedValueOnce(undefined)
    render(HairImportWizard, props)

    await reachFinalization()
    await fireEvent.click(screen.getByRole('button', { name: 'Save Hair Style' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The Hair catalog refresh failed.')
    expect(screen.getByRole('button', { name: 'Close Hair import' })).toBeInTheDocument()
    expect(props.onFinalize).toHaveBeenCalledTimes(1)

    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledTimes(2))
    expect(props.onFinalize).toHaveBeenCalledTimes(1)
    expect(props.onComplete).toHaveBeenLastCalledWith({
      assetId: 'imported-hair-1'
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a selected Anime Hair Studio sidecar paired with its OBJ inspection', async () => {
    const props = callbacks()
    render(HairImportWizard, props)

    const input = screen.getByLabelText(
      'Choose Hair OBJ or GLB with optional AHS calibration'
    )
    const geometry = new File(['o Hair\nv 0 0 0\n'], 'ahs-hair.obj', {
      type: 'text/plain'
    })
    const calibration = new File(['{"application":"Anime Hair Studio"}'], 'ahs-hair.ahs', {
      type: 'application/json'
    })
    await fireEvent.change(input, { target: { files: [geometry, calibration] } })

    expect(screen.getByText('ahs-hair.obj')).toBeInTheDocument()
    expect(screen.getByText('ahs-hair.ahs')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect and preview' }))
    await screen.findByText('Keep Only the Hair Objects')
    expect(props.onInspect).toHaveBeenCalledWith(geometry, calibration)
  })
})
