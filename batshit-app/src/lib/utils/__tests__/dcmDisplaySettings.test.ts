import { describe, expect, it } from 'vitest'
import {
  buildDcmDisplaySettingsSignature,
  cloneDcmDisplaySettings,
  createDefaultDcmDisplaySettings,
  createDefaultGatewayDcmDisplaySettings,
  normalizeDcmDisplaySettings,
  normalizeGatewayDcmDisplaySettings
} from '../dcmDisplaySettings'

describe('dcmDisplaySettings', () => {
  it('creates complete agent display settings defaults', () => {
    expect(createDefaultDcmDisplaySettings()).toEqual({
      version: 1,
      groups: {},
      tools: {},
      groupDisplayPreferences: {},
      toolDisplayPreferences: {}
    })
  })

  it('normalizes legacy modes and preserves restore preferences', () => {
    expect(
      normalizeDcmDisplaySettings({
        groups: {
          'gateway::legacy': 'group+tools',
          'gateway::names': 'group+tools+names',
          'gateway::hidden': 'hidden',
          'gateway::global': 'use-global',
          'gateway::bad': 'loud'
        },
        tools: {
          'gateway::legacyTool': 'group+tools',
          'gateway::hiddenTool': 'hidden',
          'gateway::nameOnly': 'name-only',
          'gateway::badTool': 'verbose'
        },
        groupDisplayPreferences: {
          'gateway::hidden': 'group-only',
          'gateway::bad': 'hidden'
        },
        toolDisplayPreferences: {
          'gateway::hiddenTool': 'name-only',
          'gateway::badTool': 'hidden'
        }
      })
    ).toEqual({
      version: 1,
      groups: {
        'gateway::legacy': 'group+tools+hints',
        'gateway::names': 'group+tools+names',
        'gateway::hidden': 'hidden',
        'gateway::global': 'use-global'
      },
      tools: {
        'gateway::legacyTool': 'name+hint',
        'gateway::hiddenTool': 'hidden',
        'gateway::nameOnly': 'name-only'
      },
      groupDisplayPreferences: {
        'gateway::legacy': 'group+tools+hints',
        'gateway::names': 'group+tools+names',
        'gateway::hidden': 'group-only',
        'gateway::global': 'use-global'
      },
      toolDisplayPreferences: {
        'gateway::legacyTool': 'name+hint',
        'gateway::hiddenTool': 'name-only',
        'gateway::nameOnly': 'name-only'
      }
    })
  })

  it('adds restore preferences for hidden rows when none are saved', () => {
    expect(
      normalizeDcmDisplaySettings({
        groups: {
          'gateway::group': 'hidden'
        },
        tools: {
          'gateway::tool': 'hidden'
        }
      })
    ).toEqual({
      version: 1,
      groups: {
        'gateway::group': 'hidden'
      },
      tools: {
        'gateway::tool': 'hidden'
      },
      groupDisplayPreferences: {
        'gateway::group': 'use-global'
      },
      toolDisplayPreferences: {
        'gateway::tool': 'inherit'
      }
    })
  })

  it('clones normalized settings instead of preserving object identity', () => {
    const source = {
      groups: {
        'gateway::group': 'group-only'
      },
      tools: {
        'gateway::tool': 'name+hint'
      }
    }
    const cloned = cloneDcmDisplaySettings(source)

    expect(cloned).toEqual({
      version: 1,
      groups: {
        'gateway::group': 'group-only'
      },
      tools: {
        'gateway::tool': 'name+hint'
      },
      groupDisplayPreferences: {
        'gateway::group': 'group-only'
      },
      toolDisplayPreferences: {
        'gateway::tool': 'name+hint'
      }
    })
    expect(cloned.groups).not.toBe(source.groups)
    expect(cloned.tools).not.toBe(source.tools)
  })

  it('builds a stable signature independent of record insertion order', () => {
    expect(
      buildDcmDisplaySettingsSignature({
        groups: {
          'z::group': 'group-only',
          'a::group': 'hidden'
        },
        tools: {
          'z::tool': 'name-only',
          'a::tool': 'hidden'
        }
      })
    ).toBe(
      buildDcmDisplaySettingsSignature({
        tools: {
          'a::tool': 'hidden',
          'z::tool': 'name-only'
        },
        groups: {
          'a::group': 'hidden',
          'z::group': 'group-only'
        }
      })
    )
  })

  it('creates complete gateway defaults', () => {
    expect(createDefaultGatewayDcmDisplaySettings()).toEqual({
      version: 1,
      groups: {},
      tools: {}
    })
  })

  it('normalizes gateway defaults and drops empty keys', () => {
    expect(
      normalizeGatewayDcmDisplaySettings({
        groups: {
          '': 'group-only',
          '   ': 'hidden',
          docs: 'group+tools',
          admin: 'group+tools+names',
          bad: 'use-global'
        },
        tools: {
          '': 'name-only',
          '   ': 'hidden',
          read_file: 'group+tools',
          list_files: 'name-only',
          bad: 'use-global'
        }
      })
    ).toEqual({
      version: 1,
      groups: {
        docs: 'group+tools+hints',
        admin: 'group+tools+names'
      },
      tools: {
        read_file: 'name+hint',
        list_files: 'name-only'
      }
    })
  })
})
