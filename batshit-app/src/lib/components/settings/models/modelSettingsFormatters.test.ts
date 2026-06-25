import { describe, expect, it } from 'vitest'
import type { ParameterDefinition } from '$lib/data/parameter-schemas'
import {
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

  it('matches catalog roles with vision normalized to visual', () => {
    const model = {
      id: 'test/model',
      name: 'model',
      displayName: 'Model',
      provider: 'test',
      purpose: 'vision'
    } as CatalogModel

    expect(matchesCatalogRole(model, 'visual')).toBe(true)
    expect(matchesCatalogRole(model, 'chat')).toBe(false)
    expect(matchesCatalogRole(model, 'all')).toBe(true)
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
})
