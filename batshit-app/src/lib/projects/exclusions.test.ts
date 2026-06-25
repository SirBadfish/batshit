import { describe, expect, it } from 'vitest'

import {
  PROJECT_DEFAULT_EXCLUSIONS,
  PROJECT_SECURITY_EXCLUSIONS,
  normalizeProjectExclusions
} from './exclusions'

describe('project exclusion normalization', () => {
  it('normalizes individual legacy top-level patterns to recursive patterns', () => {
    expect(
      normalizeProjectExclusions([
        'node_modules/**',
        'dist/**',
        'build/**',
        '*.log',
        '.env',
        '.env.*',
        '.git/**'
      ])
    ).toEqual(expect.arrayContaining([
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.env',
      '**/.env.*',
      '**/*.log',
      '**/.git/**'
    ]))
  })

  it('upgrades legacy defaults-enabled projects with new heavy-folder exclusions', () => {
    expect(
      normalizeProjectExclusions([
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/.cache/**',
        '**/*.log',
        '**/__pycache__/**',
        '**/.DS_Store',
        '**/target/**',
        '**/bin/**',
        '**/obj/**',
        '**/*.class',
        '**/*.pyc'
      ])
    ).toEqual(expect.arrayContaining([...PROJECT_DEFAULT_EXCLUSIONS]))
  })

  it('keeps canonical defaults and security exclusions stable', () => {
    expect(
      normalizeProjectExclusions([
        ...PROJECT_SECURITY_EXCLUSIONS,
        ...PROJECT_DEFAULT_EXCLUSIONS
      ])
    ).toEqual([
      ...PROJECT_SECURITY_EXCLUSIONS,
      ...PROJECT_DEFAULT_EXCLUSIONS
    ])
  })
})
