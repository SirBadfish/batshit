import { describe, expect, it } from 'vitest'
import type { ParameterDefinition } from '$lib/data/parameter-schemas'
import {
  CATALOG_ROLE_OPTIONS,
  formatCurrencyDisplay,
  formatDeveloperLabel,
  formatGroupedIntegerDisplay,
  formatParameterDisplayValue,
  matchesCatalogRole,
  parseFormattedNumber,
  resolveConnectionIconKey
} from './modelSettingsFormatters'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'

describe('modelSettingsFormatters', () => {
  it('formats known developer identifiers for display', () => {
    expect(formatDeveloperLabel('openai')).toBe('OpenAI')
    expect(formatDeveloperLabel('black-forest-labs')).toBe('Black Forest Labs')
    expect(formatDeveloperLabel('zai-org')).toBe('Z.ai')
    expect(formatDeveloperLabel('zai_coding')).toBe('Z.ai')
    expect(formatDeveloperLabel('made-up-ai')).toBe('Made Up AI')
  })

  it('parses and formats model number inputs', () => {
    expect(parseFormattedNumber('$1,234.500')).toBe(1234.5)
    expect(formatCurrencyDisplay('3')).toBe('$3.000')
    expect(formatGroupedIntegerDisplay('200000')).toBe('200,000')
  })

  it('formats parameter values according to parameter input type', () => {
    const integerParameter: ParameterDefinition = {
      name: 'maxTokens',
      label: 'Max Tokens',
      inputType: 'integer'
    }
    const numberParameter: ParameterDefinition = {
      name: 'temperature',
      label: 'Temperature',
      inputType: 'number',
      step: 0.01
    }

    expect(formatParameterDisplayValue(integerParameter, '4000')).toBe('4,000')
    expect(formatParameterDisplayValue(numberParameter, '0.734')).toBe('0.73')
  })

  it('defines the shared catalog filters in display order', () => {
    expect(CATALOG_ROLE_OPTIONS).toEqual([
      { value: 'all', label: 'All' },
      { value: 'chat', label: 'Text' },
      { value: 'vision', label: 'Vision' },
      { value: 'visual', label: 'Media' },
      { value: 'audio', label: 'Audio' },
      { value: 'utility', label: 'Utility' }
    ])
  })

  it('filters vision as a capability while retaining the model in Text', () => {
    const visionModel = {
      id: 'test/model',
      name: 'model',
      displayName: 'Model',
      provider: 'test',
      purpose: 'chat',
      features: { vision: true }
    } as CatalogModel
    const textOnlyModel = {
      ...visionModel,
      id: 'test/text-only',
      features: { vision: false }
    } as CatalogModel
    const mediaModel = {
      ...visionModel,
      id: 'test/media',
      purpose: 'visual',
      features: { image: true, vision: true }
    } as CatalogModel
    const legacyVisionModel = {
      ...visionModel,
      id: 'test/legacy-vision',
      purpose: 'vision',
      features: {}
    } as CatalogModel

    expect(matchesCatalogRole(visionModel, 'vision')).toBe(true)
    expect(matchesCatalogRole(visionModel, 'chat')).toBe(true)
    expect(matchesCatalogRole(textOnlyModel, 'vision')).toBe(false)
    expect(matchesCatalogRole(mediaModel, 'visual')).toBe(true)
    expect(matchesCatalogRole(mediaModel, 'vision')).toBe(false)
    expect(matchesCatalogRole(legacyVisionModel, 'vision')).toBe(true)
    expect(matchesCatalogRole(legacyVisionModel, 'chat')).toBe(true)
    expect(matchesCatalogRole(legacyVisionModel, 'visual')).toBe(false)
    expect(matchesCatalogRole(visionModel, 'all')).toBe(true)
  })

  it('uses the Docker icon key for Docker Model Runner connections', () => {
    const option = {
      id: 'direct:dmr',
      label: 'Docker Model Runner',
      transport: 'direct',
      service: 'dmr',
      status: 'ready'
    } as CatalogConnectionOption

    expect(resolveConnectionIconKey(option)).toBe('dmr')
  })

  it('uses the Batshit icon key when a connection has no provider identity', () => {
    const option = {
      id: 'custom:unknown',
      label: 'Unknown',
      transport: 'direct',
      status: 'ready'
    } as CatalogConnectionOption

    expect(resolveConnectionIconKey(option)).toBe('batshit-icon')
  })
})
