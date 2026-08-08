import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultSkinAppearanceState,
  parseSkinAppearanceDefinition
} from '$lib/goons/skinAppearance'
import type { SkinSurfaceUploadV1 } from '$lib/goons/skinSurface'
import SkinSurfaceEditor from './SkinSurfaceEditor.svelte'

function definition() {
  return parseSkinAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'static/goons/skin-appearance/v1/skin-appearance-v1.json'
        ),
        'utf8'
      )
    )
  )
}

function normalUpload(definitionSha256: string): SkinSurfaceUploadV1 {
  return {
    schemaVersion: 'skin-surface-artwork/v1',
    map: 'normal',
    url: '/uploads/goon_skin_artwork/normal.png',
    filename: 'normal.png',
    size: 123,
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    definitionSha256,
    canvas: {
      width: 2048,
      height: 2048,
      colorSpace: 'linear',
      flipY: false,
      encoding: 'rgb8-normal-opengl'
    },
    provenance: {
      sourceKind: 'user-authored',
      author: 'Josh',
      license: 'User-owned artwork',
      rightsConfirmed: true
    }
  }
}

describe('SkinSurfaceEditor', () => {
  it('shows one overall tint and the four map roles without Base Skin', () => {
    const contract = definition()
    render(SkinSurfaceEditor, {
      definition: contract,
      valueState: createDefaultSkinAppearanceState(contract),
      ownerDisplayName: 'Josh',
      creditDraft: {
        sourceKind: 'user-authored',
        externalAuthor: '',
        externalLicense: '',
        externalRightsConfirmed: false
      },
      onCreditDraftChange: vi.fn(),
      onChange: vi.fn(),
      onUpload: vi.fn()
    })

    expect(screen.getByText('Base Color Artwork')).toBeInTheDocument()
    expect(screen.getByText('Normal Map')).toBeInTheDocument()
    expect(screen.getByText('Roughness Map')).toBeInTheDocument()
    expect(screen.getByText('Metallic Map')).toBeInTheDocument()
    expect(screen.getByLabelText('Artwork Tint')).toHaveValue('#ffffff')
    expect(screen.queryByText('Base Skin')).not.toBeInTheDocument()
  })

  it('keeps map panels mounted and reveals the selected panel without a transition race', async () => {
    const contract = definition()
    const { container } = render(SkinSurfaceEditor, {
      definition: contract,
      valueState: createDefaultSkinAppearanceState(contract),
      ownerDisplayName: 'Josh',
      creditDraft: {
        sourceKind: 'user-authored',
        externalAuthor: '',
        externalLicense: '',
        externalRightsConfirmed: false
      },
      onCreditDraftChange: vi.fn(),
      onChange: vi.fn(),
      onUpload: vi.fn()
    })

    const baseColorPanel = container.querySelector(
      '#facial-artwork-skin-surface-baseColor-panel'
    )
    const normalPanel = container.querySelector(
      '#facial-artwork-skin-surface-normal-panel'
    )

    expect(baseColorPanel).not.toBeNull()
    expect(normalPanel).not.toBeNull()
    expect(baseColorPanel).not.toHaveAttribute('hidden')
    expect(normalPanel).toHaveAttribute('hidden')

    await fireEvent.click(screen.getByRole('button', { name: 'Normal Map', exact: true }))

    expect(baseColorPanel).toHaveAttribute('hidden')
    expect(normalPanel).not.toHaveAttribute('hidden')
  })

  it('uploads a Normal independently and emits Custom Normal state', async () => {
    const contract = definition()
    const onChange = vi.fn()
    const upload = normalUpload(contract.definitionSha256)
    const onUpload = vi.fn().mockResolvedValue(upload)
    render(SkinSurfaceEditor, {
      definition: contract,
      valueState: createDefaultSkinAppearanceState(contract),
      ownerDisplayName: 'Josh',
      creditDraft: {
        sourceKind: 'user-authored',
        externalAuthor: '',
        externalLicense: '',
        externalRightsConfirmed: false
      },
      onCreditDraftChange: vi.fn(),
      onChange,
      onUpload
    })

    const file = new File(['normal'], 'normal.png', { type: 'image/png' })
    await fireEvent.change(screen.getByLabelText('Choose Normal Map PNG'), {
      target: { files: [file] }
    })

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('normal', file, upload.provenance))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({
          normal: expect.objectContaining({ mode: 'custom', custom: upload })
        })
      })
    )
  })
})
