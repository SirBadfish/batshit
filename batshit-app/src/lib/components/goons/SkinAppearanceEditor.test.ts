import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultSkinAppearanceState,
  parseSkinAppearanceDefinition
} from '$lib/goons/skinAppearance'
import SkinAppearanceEditor from './SkinAppearanceEditor.svelte'

function definition() {
  return parseSkinAppearanceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/skin-appearance/v1/skin-appearance-v1.json'),
        'utf8'
      )
    )
  )
}

describe('SkinAppearanceEditor', () => {
  it('shows exact package inheritance with color disabled until Custom is active', () => {
    const contract = definition()
    render(SkinAppearanceEditor, {
      definition: contract,
      valueState: createDefaultSkinAppearanceState(contract),
      regionId: 'nipplesAreolae',
      onChange: vi.fn()
    })

    expect(screen.getByText('Nipples & Areolae')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Nipples & Areolae mode' })
    ).toHaveTextContent('Package')
    expect(screen.getByLabelText('Nipples & Areolae color')).toBeDisabled()
    expect(screen.queryByText('Base Skin')).not.toBeInTheDocument()
  })

  it('emits literal custom color state for the exact selected region', async () => {
    const contract = definition()
    const state = createDefaultSkinAppearanceState(contract)
    state.regions.palmsSoles.mode = 'custom'
    const onChange = vi.fn()
    render(SkinAppearanceEditor, {
      definition: contract,
      valueState: state,
      regionId: 'palmsSoles',
      onChange
    })

    const color = screen.getByLabelText('Palms & Soles color')
    expect(color).not.toBeDisabled()
    await fireEvent.input(color, { target: { value: '#804020' } })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        regions: expect.objectContaining({
          palmsSoles: {
            mode: 'custom',
            color: [0.501961, 0.25098, 0.12549]
          }
        })
      })
    )
  })
})
