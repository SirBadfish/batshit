import { describe, expect, it, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_GOON_STUDIO_TUNING,
  GoonSceneLighting,
  LEGACY_GOON_LIGHTING,
  VRM_LANE_COMPENSATION,
  resolveGoonLightingMode,
  resolveGoonToneMappingMode
} from './sceneLighting'

function lightsOf(scene: THREE.Scene) {
  return scene.children.filter((child): child is THREE.Light => (child as THREE.Light).isLight)
}

afterEach(() => {
  vi.unstubAllGlobals()
  try {
    globalThis.localStorage?.clear()
  } catch {
    // no-op
  }
})

describe('GoonSceneLighting legacy rig', () => {
  it('reproduces the exact rig every accepted Goon was reviewed under', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)

    lighting.applyMode('legacy', null)

    const lights = lightsOf(scene)
    const ambient = lights.find((light) => (light as THREE.AmbientLight).isAmbientLight)
    const key = lights.find((light) => (light as THREE.DirectionalLight).isDirectionalLight)

    expect(lights).toHaveLength(2)
    expect(ambient?.intensity).toBe(LEGACY_GOON_LIGHTING.ambientIntensity)
    expect(key?.intensity).toBe(LEGACY_GOON_LIGHTING.keyIntensity)
    expect(key?.position.toArray()).toEqual([
      LEGACY_GOON_LIGHTING.keyPosition.x,
      LEGACY_GOON_LIGHTING.keyPosition.y,
      LEGACY_GOON_LIGHTING.keyPosition.z
    ])
  })

  it('leaves the scene environment untouched so opting out is complete', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)

    lighting.applyMode('legacy', null)

    expect(scene.environment).toBeNull()
    expect(scene.environmentIntensity).toBe(1)
  })
})

function studioLights(scene: THREE.Scene) {
  const lights = lightsOf(scene)
  return {
    ambient: lights.find(
      (light): light is THREE.AmbientLight => (light as THREE.AmbientLight).isAmbientLight
    ),
    hemisphere: lights.find(
      (light): light is THREE.HemisphereLight => (light as THREE.HemisphereLight).isHemisphereLight
    ),
    key: lights.find(
      (light): light is THREE.DirectionalLight =>
        (light as THREE.DirectionalLight).isDirectionalLight
    )
  }
}

describe('GoonSceneLighting studio rig', () => {
  it('adds a hemisphere fill and keeps a small ambient floor against black crush', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)

    lighting.applyMode('studio', null)

    const { ambient, hemisphere, key } = studioLights(scene)
    expect(lightsOf(scene)).toHaveLength(3)
    expect(hemisphere).toBeDefined()
    expect(key).toBeDefined()
    expect(ambient?.intensity).toBeGreaterThan(0)
    expect(ambient?.intensity).toBeLessThan(LEGACY_GOON_LIGHTING.ambientIntensity)
  })

  it('applies live tuning to the mounted lights', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.setTuning({ hemisphereIntensity: 0.9, keyIntensity: 0.2, environmentIntensity: 0.7 })

    const { hemisphere, key } = studioLights(scene)
    expect(hemisphere?.intensity).toBe(0.9)
    expect(key?.intensity).toBe(0.2)
    expect(scene.environmentIntensity).toBe(0.7)
  })

  it('scales every analytic light by the brightness knob', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.setTuning({ brightness: 2 })

    const { ambient, hemisphere, key } = studioLights(scene)
    expect(ambient?.intensity).toBeCloseTo(DEFAULT_GOON_STUDIO_TUNING.ambientFloor * 2, 6)
    expect(hemisphere?.intensity).toBeCloseTo(DEFAULT_GOON_STUDIO_TUNING.hemisphereIntensity * 2, 6)
    expect(key?.intensity).toBeCloseTo(DEFAULT_GOON_STUDIO_TUNING.keyIntensity * 2, 6)
    expect(scene.environmentIntensity).toBeCloseTo(
      DEFAULT_GOON_STUDIO_TUNING.environmentIntensity * 2,
      6
    )
  })
})

describe('studio calibration pins', () => {
  // These exact values were solved on the live WebGPU backend so both Goon
  // lanes reproduce the legacy rig's mean linear luminance. Changing one
  // silently un-matches the A/B and makes any surface verdict unfair, so a
  // change here must come with a fresh measurement.
  it('holds the measured legacy-matched studio tuning', () => {
    expect(DEFAULT_GOON_STUDIO_TUNING.environmentIntensity).toBe(0.2063)
    expect(DEFAULT_GOON_STUDIO_TUNING.hemisphereIntensity).toBe(0.1548)
    expect(DEFAULT_GOON_STUDIO_TUNING.ambientFloor).toBe(0.1135)
    expect(DEFAULT_GOON_STUDIO_TUNING.keyIntensity).toBe(0.2579)
    expect(DEFAULT_GOON_STUDIO_TUNING.brightness).toBe(1)
    expect(VRM_LANE_COMPENSATION).toBe(3.2604)
  })

  it('keeps an ambient floor so occluded surfaces cannot crush to black', () => {
    expect(DEFAULT_GOON_STUDIO_TUNING.ambientFloor).toBeGreaterThan(0)
  })
})

describe('GoonSceneLighting lane compensation', () => {
  it('compensates the analytic lights when nothing can consume the environment', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.setEnvironmentConsumerPresent(false)

    const { ambient, hemisphere, key } = studioLights(scene)
    expect(ambient?.intensity).toBeCloseTo(
      DEFAULT_GOON_STUDIO_TUNING.ambientFloor * VRM_LANE_COMPENSATION,
      6
    )
    expect(hemisphere?.intensity).toBeCloseTo(
      DEFAULT_GOON_STUDIO_TUNING.hemisphereIntensity * VRM_LANE_COMPENSATION,
      6
    )
    expect(key?.intensity).toBeCloseTo(
      DEFAULT_GOON_STUDIO_TUNING.keyIntensity * VRM_LANE_COMPENSATION,
      6
    )
  })

  it('leaves environment intensity alone, since the compensated lane cannot see it', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.setEnvironmentConsumerPresent(false)

    expect(scene.environmentIntensity).toBeCloseTo(
      DEFAULT_GOON_STUDIO_TUNING.environmentIntensity,
      6
    )
  })

  it('returns to the GLB calibration when an environment consumer appears', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.setEnvironmentConsumerPresent(false)
    lighting.setEnvironmentConsumerPresent(true)

    const { key } = studioLights(scene)
    expect(key?.intensity).toBeCloseTo(DEFAULT_GOON_STUDIO_TUNING.keyIntensity, 6)
  })

  it('never compensates the legacy control rig', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('legacy', null)

    lighting.setEnvironmentConsumerPresent(false)

    const { ambient, key } = studioLights(scene)
    expect(ambient?.intensity).toBe(LEGACY_GOON_LIGHTING.ambientIntensity)
    expect(key?.intensity).toBe(LEGACY_GOON_LIGHTING.keyIntensity)
  })

  it('ignores tuning while in legacy mode so the control cannot drift', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('legacy', null)

    lighting.setTuning({ keyIntensity: 0.2 })

    const key = lightsOf(scene).find(
      (light): light is THREE.DirectionalLight =>
        (light as THREE.DirectionalLight).isDirectionalLight
    )
    expect(key?.intensity).toBe(LEGACY_GOON_LIGHTING.keyIntensity)
    expect(scene.environmentIntensity).toBe(1)
  })
})

describe('GoonSceneLighting mode switching', () => {
  it('never stacks lights across repeated switches', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)

    lighting.applyMode('studio', null)
    lighting.applyMode('legacy', null)
    lighting.applyMode('studio', null)
    lighting.applyMode('studio', null)
    lighting.applyMode('legacy', null)

    const lights = lightsOf(scene)
    expect(lights).toHaveLength(2)
    expect(lights.filter((light) => (light as THREE.AmbientLight).isAmbientLight)).toHaveLength(1)
    expect(
      lights.filter((light) => (light as THREE.HemisphereLight).isHemisphereLight)
    ).toHaveLength(0)
  })

  it('removes every light on dispose', () => {
    const scene = new THREE.Scene()
    const lighting = new GoonSceneLighting(scene)
    lighting.applyMode('studio', null)

    lighting.dispose()

    expect(lightsOf(scene)).toHaveLength(0)
    expect(scene.environment).toBeNull()
  })
})

describe('lighting mode resolution', () => {
  it('defaults to the legacy rig and no tone mapping', () => {
    vi.stubGlobal('location', { search: '' })
    expect(resolveGoonLightingMode()).toBe('legacy')
    expect(resolveGoonToneMappingMode()).toBe('none')
  })

  it('reads the studio opt-in from the query string', () => {
    vi.stubGlobal('location', { search: '?goonLighting=studio&goonToneMapping=agx' })
    expect(resolveGoonLightingMode()).toBe('studio')
    expect(resolveGoonToneMappingMode()).toBe('agx')
  })

  it('reads the opt-in from local storage when no query is present', () => {
    vi.stubGlobal('location', { search: '' })
    globalThis.localStorage.setItem('batshit:goonLighting', 'studio')
    globalThis.localStorage.setItem('batshit:goonToneMapping', 'neutral')

    expect(resolveGoonLightingMode()).toBe('studio')
    expect(resolveGoonToneMappingMode()).toBe('neutral')
  })

  it('lets the query string win over stored state', () => {
    vi.stubGlobal('location', { search: '?goonLighting=legacy' })
    globalThis.localStorage.setItem('batshit:goonLighting', 'studio')

    expect(resolveGoonLightingMode()).toBe('legacy')
  })

  it('makes a query choice sticky so navigation cannot silently revert the rig', () => {
    vi.stubGlobal('location', { search: '?goonLighting=studio' })
    expect(resolveGoonLightingMode()).toBe('studio')

    // The reviewer navigates; SvelteKit drops the query string.
    vi.stubGlobal('location', { search: '' })
    expect(resolveGoonLightingMode()).toBe('studio')
  })

  it('lets the opposite query value switch a sticky choice back', () => {
    vi.stubGlobal('location', { search: '?goonLighting=studio' })
    expect(resolveGoonLightingMode()).toBe('studio')

    vi.stubGlobal('location', { search: '?goonLighting=legacy' })
    expect(resolveGoonLightingMode()).toBe('legacy')

    vi.stubGlobal('location', { search: '' })
    expect(resolveGoonLightingMode()).toBe('legacy')
  })

  it('falls back to the default when the value is not a known mode', () => {
    vi.stubGlobal('location', { search: '?goonLighting=cinematic&goonToneMapping=filmic' })
    expect(resolveGoonLightingMode()).toBe('legacy')
    expect(resolveGoonToneMappingMode()).toBe('none')
  })
})
