import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import FacialArtworkEditor from './FacialArtworkEditor.svelte'
import {
  FACIAL_ARTWORK_ROLE_IDS,
  createDefaultFacialArtworkState,
  type FacialArtworkDefinitionV2,
  type FacialArtworkRoleDefinition
} from '$lib/goons/facialArtwork'
import {
  EYE_APPEARANCE_CONTROL_IDS,
  createDefaultEyeAppearanceState,
  type EyeAppearanceControlDefinition,
  type EyeAppearanceDefinitionV1
} from '$lib/goons/eyeAppearance'

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

const HASH = 'a'.repeat(64)

function buildFacialArtworkDefinition(): FacialArtworkDefinitionV2 {
  const roleDefinitions = FACIAL_ARTWORK_ROLE_IDS.map((id) => {
    const mapping = id === 'sclera' ? 'longitude' : id === 'iris' || id === 'pupil' || id === 'eye_highlight' ? 'radial' : 'planar'
    const baseColor = id === 'iris' ? [0.1, 0.5, 0.6] : id === 'pupil' ? [0.02, 0.02, 0.02] : id === 'sclera' ? [0.92, 0.9, 0.86] : null
    return {
      id,
      template: `${id}_template`,
      ownership: id === 'eye_highlight' ? 'lit-overlay' : id === 'brows' || id === 'lashes_eye_outline' ? 'canvas' : 'lit-surface',
      mapping,
      target: {
        left: { runtimeNodes: [`${id}_left`], mirrorU: false, mirrorV: false },
        right: { runtimeNodes: [`${id}_right`], mirrorU: id === 'brows' || id === 'lashes_eye_outline', mirrorV: false }
      },
      defaultEyeState: { visible: baseColor !== null, baseColor, artwork: null },
      defaultMode: 'shared',
      bounds:
        mapping === 'longitude'
          ? { longitudeDegrees: [-180, 180] }
          : {
              translateU: [-1, 1],
              translateV: [-1, 1],
              scale: [0.25, 4],
              rotationDegrees: [-180, 180]
            }
    } as FacialArtworkRoleDefinition
  })

  return {
    schemaVersion: 'facial-artwork/v2',
    stateSchemaVersion: 'facial-artwork-state/v2',
    productExportApproved: false,
    definitionSha256: HASH,
    templateSet: { id: 'test', version: '2.0.0' },
    templates: FACIAL_ARTWORK_ROLE_IDS.map((id) => ({
      id: `${id}_template`,
      version: '2.0.0',
      dimensions: [1024, 1024],
      guide: { path: `goons/facial-artwork/v2/${id}/guide.png`, sha256: HASH },
      safePaintMask: { path: `goons/facial-artwork/v2/${id}/mask.png`, sha256: HASH },
      transparentBlank: { path: `goons/facial-artwork/v2/${id}/blank.png`, sha256: HASH }
    })),
    roles: roleDefinitions
  }
}

function buildEyeAppearanceDefinition(): EyeAppearanceDefinitionV1 {
  const labels: Record<(typeof EYE_APPEARANCE_CONTROL_IDS)[number], string> = {
    iris_size: 'Iris Size',
    pupil_size: 'Pupil Size',
    sclera_scale: 'Sclera Scale',
    sclera_tilt: 'Sclera Tilt',
    sclera_horizontal_position: 'Sclera Horizontal Position',
    sclera_vertical_position: 'Sclera Vertical Position',
    sclera_depth: 'Sclera Depth'
  }
  const controls = EYE_APPEARANCE_CONTROL_IDS.map((id) => ({
    id,
    label: labels[id],
    minimum: -1,
    maximum: 1,
    step: 0.01,
    default: 0,
    unit: 'post-fit-multiplier-offset',
    linkedBilateral: true,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: `${labels[id]} test control`
  })) as EyeAppearanceControlDefinition[]

  return {
    schemaVersion: 'eye-appearance/v1',
    stateSchemaVersion: 'eye-appearance-state/v1',
    status: 'test',
    productExportApproved: false,
    definitionSha256: HASH,
    facialArtworkDependency: {
      schemaVersion: 'facial-artwork/v2',
      definitionSha256: HASH
    },
    ownership: 'test',
    zeroLaw: 'Zero keeps the fitted result.',
    symmetryLaw: 'All physical controls are linked.',
    compositionOrder: ['automatic-fit', 'user-offset'],
    completeEyeAssemblyNodes: ['EyeAssembly_L', 'EyeAssembly_R'],
    solidColorDefaults: {
      iris: [0.1, 0.5, 0.6, 1],
      pupil: [0.02, 0.02, 0.02, 1],
      sclera: [0.92, 0.9, 0.86, 1]
    },
    controls,
    rangeEvidence: { schemaVersion: 'test', sha256: HASH, canonicalSha256: HASH }
  } as EyeAppearanceDefinitionV1
}

function renderEditor() {
  const definition = buildFacialArtworkDefinition()
  const eyeAppearanceDefinition = buildEyeAppearanceDefinition()
  return render(FacialArtworkEditor, {
    definition,
    eyeAppearanceDefinition,
    valueState: createDefaultFacialArtworkState(definition),
    eyeAppearanceState: createDefaultEyeAppearanceState(eyeAppearanceDefinition),
    onChange: vi.fn(),
    onEyeAppearanceChange: vi.fn(),
    onUpload: vi.fn()
  })
}

describe('FacialArtworkEditor', () => {
  it('uses the five locked product accordions without the retired treatment label', () => {
    renderEditor()

    for (const label of ['Brows', 'Lashes & Eye Outline', 'Iris & Pupil', 'Eye Highlight', 'Sclera']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.queryByText(/Eye Treatment/i)).not.toBeInTheDocument()
    expect(screen.getByText('0 of 5 sections changed')).toHaveAttribute('aria-live', 'polite')
  })

  it('offers Same or Customize for all six artwork roles and explains shared mirroring', async () => {
    renderEditor()

    expect(screen.getByRole('button', { name: 'Customize each eye' })).toBeInTheDocument()
    expect(screen.getByText('The right brow mirrors the left automatically.')).toBeInTheDocument()

    for (const [accordion, expectedCount] of [
      [/Lashes & Eye Outline/, 1],
      [/Iris & Pupil/, 2],
      [/Eye Highlight/, 1],
      [/^Sclera/, 1]
    ] as const) {
      await fireEvent.click(screen.getByRole('button', { name: accordion }))
      expect(screen.getAllByRole('button', { name: 'Customize each eye' })).toHaveLength(expectedCount)
    }
  })

  it('keeps Iris and Pupil stacked with independent artwork symmetry and linked physical sizes', async () => {
    renderEditor()
    await fireEvent.click(screen.getByRole('button', { name: /Iris & Pupil/ }))

    const panel = screen.getByRole('region', { name: /Iris & Pupil/ })
    expect(within(panel).getByText('Iris')).toBeInTheDocument()
    expect(within(panel).getByText('Pupil')).toBeInTheDocument()
    expect(within(panel).getAllByRole('button', { name: 'Customize each eye' })).toHaveLength(2)
    expect(within(panel).getByText('Iris Size')).toBeInTheDocument()
    expect(within(panel).getByText('Pupil Size')).toBeInTheDocument()
    expect(within(panel).getAllByText(/Linked across both eyes/)).toHaveLength(2)
  })

  it('shows only the five enabled physical Sclera Fit controls', async () => {
    renderEditor()
    await fireEvent.click(screen.getByRole('button', { name: /^Sclera/ }))

    const panel = screen.getByRole('region', { name: /^Sclera Same for both/ })
    expect(within(panel).getByText('Surface')).toBeInTheDocument()
    expect(within(panel).getByText('Sclera Fit')).toBeInTheDocument()
    for (const label of [
      'Sclera Scale',
      'Sclera Tilt',
      'Sclera Horizontal Position',
      'Sclera Vertical Position',
      'Sclera Depth'
    ]) {
      expect(within(panel).getByText(label)).toBeInTheDocument()
    }
    expect(within(panel).queryByText('Artwork Horizontal Position')).not.toBeInTheDocument()
    expect(within(panel).queryByText('Artwork Vertical Position')).not.toBeInTheDocument()
    expect(within(panel).queryByText('Artwork Scale')).not.toBeInTheDocument()
  })
})
