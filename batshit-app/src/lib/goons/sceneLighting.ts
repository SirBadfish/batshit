import * as THREE from 'three'
import { PMREMGenerator, type WebGPURenderer } from 'three/webgpu'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/**
 * Goon scene lighting modes.
 *
 * `legacy` reproduces the original rig exactly (flat ambient + one directional)
 * and stays the default so no shipped Goon changes appearance until the studio
 * rig is accepted. `studio` is the SA-090 surface-material research ladder's
 * L1 + L2: image-based lighting plus a two-tone hemisphere fill, so surface
 * orientation carries light away from the key and normal/roughness maps become
 * readable on the shadow side.
 */
export type GoonLightingMode = 'legacy' | 'studio'

/** Tone-mapping options (research ladder L4). Independent of the lighting mode. */
export type GoonToneMappingMode = 'none' | 'agx' | 'aces' | 'neutral'

export const GOON_LIGHTING_MODES: readonly GoonLightingMode[] = ['legacy', 'studio']
export const GOON_TONE_MAPPING_MODES: readonly GoonToneMappingMode[] = [
  'none',
  'agx',
  'aces',
  'neutral'
]

export const DEFAULT_GOON_LIGHTING_MODE: GoonLightingMode = 'legacy'
export const DEFAULT_GOON_TONE_MAPPING_MODE: GoonToneMappingMode = 'none'

/**
 * The exact original rig, kept as named constants so the A/B control cannot
 * drift away from what every currently accepted Goon was reviewed under.
 */
export const LEGACY_GOON_LIGHTING = {
  ambientIntensity: 0.6,
  keyIntensity: 0.8,
  keyPosition: { x: 1, y: 2, z: 2 }
} as const

export interface GoonStudioLightingTuning {
  /** `scene.environmentIntensity` applied to the PMREM room environment. */
  environmentIntensity: number
  /** Hemisphere sky/ground fill, supplying direction the flat ambient cannot. */
  hemisphereIntensity: number
  /**
   * Small omnidirectional floor. Deliberately retained rather than removed with
   * the legacy ambient: it is what stops deeply occluded surfaces (under-chin,
   * inner arm, between the legs) from crushing to black once the fill becomes
   * directional.
   */
  ambientFloor: number
  /** Directional key intensity; lowered because IBL now supplies broad fill. */
  keyIntensity: number
  skyColor: number
  groundColor: number
  /** Deliberate overall exposure deviation. `1` is the legacy-matched result. */
  brightness: number
}

/**
 * Measured, not guessed.
 *
 * These four intensities were solved on the live WebGPU backend against a
 * humanoid proxy (torso/head/arms/legs, so downward-facing and self-occluded
 * surfaces are represented — a sphere badly under-reports this) with the v33
 * body's material profile: near-flat albedo, uniform roughness `0.7`, no AO.
 * They reproduce the legacy rig's mean linear luminance to within `0.1%`, with
 * no pixel crushed to black, so the A/B reads as a difference in *form* rather
 * than a difference in brightness.
 *
 * The first attempt at this rig was ~94% too bright on that proxy while reading
 * far too dark on VRM Goons — see `VRM_LANE_COMPENSATION`.
 */
export const DEFAULT_GOON_STUDIO_TUNING: GoonStudioLightingTuning = {
  environmentIntensity: 0.2063,
  hemisphereIntensity: 0.1548,
  ambientFloor: 0.1135,
  keyIntensity: 0.2579,
  skyColor: 0xdfe7f2,
  groundColor: 0x3d3a36,
  brightness: 1
}

/**
 * Environment light carries **69.3%** of the studio rig on the first-party GLB
 * lane and exactly **0%** on the VRM lane, because `MToonNodeMaterial` has no
 * environment code path at all. One set of intensities therefore cannot serve
 * both lanes: calibrating for GLB leaves VRM Goons ~69% darker than legacy,
 * which is precisely the "a lot darker" failure this constant exists to fix.
 *
 * When no environment-consuming Goon is present, the analytic lights absorb the
 * missing energy by this measured factor, landing the VRM lane back on the
 * legacy mean.
 */
export const VRM_LANE_COMPENSATION = 3.2604

const TONE_MAPPING_BY_MODE: Record<GoonToneMappingMode, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping
}

/**
 * Resolves a review choice from `?key=value`, falling back to a previously
 * stored choice.
 *
 * The query value is *sticky*: seeing it once writes it to local storage. That
 * keeps a review session on the chosen rig while the reviewer navigates around
 * the app, instead of silently reverting the moment SvelteKit drops the query
 * string. Pasting the other value switches back, so the A/B stays two URLs
 * rather than a console incantation.
 */
function resolveDebugChoice<T extends string>(
  queryKey: string,
  storageKey: string,
  allowed: readonly T[],
  fallback: T
): T {
  const matches = (value: string | null | undefined): T | null => {
    if (!value) return null
    const normalized = value.trim().toLowerCase()
    return allowed.find((entry) => entry === normalized) ?? null
  }

  const storage = (() => {
    try {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null
    } catch {
      return null
    }
  })()

  try {
    const location = (globalThis as { location?: Location }).location
    const fromQuery = location?.search
      ? matches(new URLSearchParams(location.search).get(queryKey))
      : null
    if (fromQuery) {
      try {
        storage?.setItem(storageKey, fromQuery)
      } catch {
        // no-op
      }
      return fromQuery
    }
  } catch {
    // no-op
  }

  try {
    const fromStorage = matches(storage?.getItem(storageKey))
    if (fromStorage) return fromStorage
  } catch {
    // no-op
  }

  return fallback
}

export function resolveGoonLightingMode(): GoonLightingMode {
  return resolveDebugChoice(
    'goonLighting',
    'batshit:goonLighting',
    GOON_LIGHTING_MODES,
    DEFAULT_GOON_LIGHTING_MODE
  )
}

export function resolveGoonToneMappingMode(): GoonToneMappingMode {
  return resolveDebugChoice(
    'goonToneMapping',
    'batshit:goonToneMapping',
    GOON_TONE_MAPPING_MODES,
    DEFAULT_GOON_TONE_MAPPING_MODE
  )
}

/**
 * Optional exposure override, e.g. `?goonLightingBrightness=1.4`. Sticky like
 * the other review switches. `1` is the measured legacy-matched result.
 */
export function resolveGoonLightingBrightness(): number {
  const storageKey = 'batshit:goonLightingBrightness'
  const parse = (raw: string | null | undefined) => {
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 && value <= 10 ? value : null
  }

  let storage: Storage | null = null
  try {
    storage = (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    storage = null
  }

  try {
    const location = (globalThis as { location?: Location }).location
    const fromQuery = location?.search
      ? parse(new URLSearchParams(location.search).get('goonLightingBrightness'))
      : null
    if (fromQuery !== null) {
      try {
        storage?.setItem(storageKey, String(fromQuery))
      } catch {
        // no-op
      }
      return fromQuery
    }
  } catch {
    // no-op
  }

  try {
    const fromStorage = parse(storage?.getItem(storageKey))
    if (fromStorage !== null) return fromStorage
  } catch {
    // no-op
  }

  return DEFAULT_GOON_STUDIO_TUNING.brightness
}

/**
 * Clears every sticky review switch. Reachable from the console as
 * `__batshitGoonLighting.reset()` because sticky state that survives a hard
 * reload is exactly the kind of hidden state that silently poisons a later
 * comparison — a one-off tone-mapping experiment persisted into an entire
 * review round before this existed.
 */
export function clearGoonLightingOverrides() {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    storage?.removeItem('batshit:goonLighting')
    storage?.removeItem('batshit:goonToneMapping')
    storage?.removeItem('batshit:goonLightingBrightness')
  } catch {
    // no-op
  }
}

export interface GoonLightingDiagnostics {
  mode: GoonLightingMode
  toneMapping: GoonToneMappingMode
  environmentConsumerPresent: boolean
  environmentAttached: boolean
  laneGain: number
  lights: { ambient: number | null; hemisphere: number | null; key: number | null }
  environmentIntensity: number
}

/**
 * Publishes the live rig to `globalThis.__batshitGoonLighting` so the active
 * lighting state is inspectable from the console instead of inferred from
 * screenshots. A WebGPU canvas cannot be read back with `drawImage`, so this is
 * the supported way to confirm what a Goon is actually lit by.
 */
export function publishGoonLightingDiagnostics(
  snapshot: GoonLightingDiagnostics,
  controls: {
    setMode?: (mode: GoonLightingMode) => void
    setTuning?: (partial: Partial<GoonStudioLightingTuning>) => void
  } = {}
) {
  try {
    const target = globalThis as Record<string, unknown>
    target.__batshitGoonLighting = {
      ...snapshot,
      reset: clearGoonLightingOverrides,
      ...controls
    }
  } catch {
    // no-op
  }
}

export function applyGoonToneMapping(
  renderer: WebGPURenderer,
  mode: GoonToneMappingMode,
  exposure = 1
) {
  renderer.toneMapping = TONE_MAPPING_BY_MODE[mode] ?? THREE.NoToneMapping
  renderer.toneMappingExposure = exposure
}

/**
 * Owns every light and the environment map for the main Goon scene.
 *
 * Only `scene.environment` is written here; `scene.background` stays under the
 * skybox system's ownership so switching lighting modes can never change what
 * the viewer sees behind the Goon.
 *
 * Note for regression review: `scene.environment` reaches the first-party GLB
 * Goon materials (MeshStandard/Physical family) but not VRM Goons, whose
 * `MToonNodeMaterial` consumes no environment input at all. The hemisphere fill
 * *does* reach MToon, so VRM Goons must be part of any acceptance pass before
 * `studio` becomes the product default.
 */
export class GoonSceneLighting {
  private scene: THREE.Scene
  private mode: GoonLightingMode = DEFAULT_GOON_LIGHTING_MODE
  private tuning: GoonStudioLightingTuning = { ...DEFAULT_GOON_STUDIO_TUNING }
  private environmentConsumerPresent = true
  private renderer: WebGPURenderer | null = null
  private toneMappingMode: GoonToneMappingMode = DEFAULT_GOON_TONE_MAPPING_MODE

  private ambient: THREE.AmbientLight | null = null
  private hemisphere: THREE.HemisphereLight | null = null
  private key: THREE.DirectionalLight | null = null
  private environmentTarget: THREE.RenderTarget | null = null
  private pmrem: PMREMGenerator | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  getMode() {
    return this.mode
  }

  getTuning(): GoonStudioLightingTuning {
    return { ...this.tuning }
  }

  /**
   * Declares whether the scene currently holds a Goon whose materials can
   * consume `scene.environment` (the first-party GLB lane). A VRM-only scene
   * cannot, and gets the compensated analytic rig instead so it does not read
   * dramatically darker than legacy.
   *
   * A mixed scene reports `true`: the GLB calibration is the SA-090 target lane,
   * and over-lighting a VRM companion is the safer error than crushing the Goon
   * whose skin is actually under review.
   */
  setEnvironmentConsumerPresent(present: boolean) {
    if (this.environmentConsumerPresent === present) return
    this.environmentConsumerPresent = present
    if (this.mode !== 'studio') return
    this.applyStudioIntensities()
  }

  /** Effective analytic-light multiplier for the current lane. */
  private laneGain() {
    const compensation = this.environmentConsumerPresent ? 1 : VRM_LANE_COMPENSATION
    return this.tuning.brightness * compensation
  }

  private applyStudioIntensities() {
    const gain = this.laneGain()
    if (this.ambient) this.ambient.intensity = this.tuning.ambientFloor * gain
    if (this.hemisphere) {
      this.hemisphere.intensity = this.tuning.hemisphereIntensity * gain
      this.hemisphere.color.set(this.tuning.skyColor)
      this.hemisphere.groundColor.set(this.tuning.groundColor)
    }
    if (this.key) this.key.intensity = this.tuning.keyIntensity * gain
    // Environment contributes nothing on the VRM lane, so leaving its intensity
    // at the calibrated value is correct — the compensation belongs on the
    // analytic lights that lane can actually see.
    this.scene.environmentIntensity = this.tuning.environmentIntensity * this.tuning.brightness
    this.publishDiagnostics()
  }

  private publishDiagnostics() {
    publishGoonLightingDiagnostics(
      {
        mode: this.mode,
        toneMapping: this.toneMappingMode,
        environmentConsumerPresent: this.environmentConsumerPresent,
        environmentAttached: !!this.scene.environment,
        laneGain: this.mode === 'studio' ? this.laneGain() : 1,
        lights: {
          ambient: this.ambient?.intensity ?? null,
          hemisphere: this.hemisphere?.intensity ?? null,
          key: this.key?.intensity ?? null
        },
        environmentIntensity: this.scene.environmentIntensity
      },
      {
        setMode: (mode) => this.applyMode(mode, this.renderer),
        setTuning: (partial: Partial<GoonStudioLightingTuning>) => this.setTuning(partial)
      }
    )
  }

  /** Recorded only so diagnostics can report the full active rig. */
  setToneMappingModeForDiagnostics(mode: GoonToneMappingMode) {
    this.toneMappingMode = mode
    this.publishDiagnostics()
  }

  /**
   * Builds (or rebuilds) the rig for `mode`. Safe to call repeatedly; the
   * previous rig is fully torn down first so mode switches cannot stack lights.
   */
  applyMode(mode: GoonLightingMode, renderer: WebGPURenderer | null) {
    this.mode = mode
    if (renderer) this.renderer = renderer
    this.teardownLights()

    const key = new THREE.DirectionalLight(0xffffff, LEGACY_GOON_LIGHTING.keyIntensity)
    key.position.set(
      LEGACY_GOON_LIGHTING.keyPosition.x,
      LEGACY_GOON_LIGHTING.keyPosition.y,
      LEGACY_GOON_LIGHTING.keyPosition.z
    )
    this.key = key

    if (mode === 'legacy') {
      this.releaseEnvironment()
      this.ambient = new THREE.AmbientLight(0xffffff, LEGACY_GOON_LIGHTING.ambientIntensity)
      this.scene.add(this.ambient, key)
      this.publishDiagnostics()
      return
    }

    this.ambient = new THREE.AmbientLight(0xffffff, this.tuning.ambientFloor)
    this.hemisphere = new THREE.HemisphereLight(
      this.tuning.skyColor,
      this.tuning.groundColor,
      this.tuning.hemisphereIntensity
    )
    this.scene.add(this.ambient, this.hemisphere, key)
    this.ensureEnvironment(renderer ?? this.renderer)
    this.applyStudioIntensities()
  }

  /** Live tuning for review sessions; only meaningful in `studio` mode. */
  setTuning(partial: Partial<GoonStudioLightingTuning>) {
    this.tuning = { ...this.tuning, ...partial }
    if (this.mode !== 'studio') return
    this.applyStudioIntensities()
  }

  dispose() {
    this.teardownLights()
    this.releaseEnvironment()
  }

  private ensureEnvironment(renderer: WebGPURenderer | null) {
    if (this.environmentTarget) {
      this.scene.environment = this.environmentTarget.texture
      return
    }
    if (!renderer) return

    // PMREMGenerator warns and degrades if the backend is not ready; the engine
    // only reaches this after `await renderer.init()`.
    const pmrem = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    try {
      const target = pmrem.fromScene(room, 0.04)
      this.environmentTarget = target
      this.pmrem = pmrem
      this.scene.environment = target.texture
    } finally {
      room.dispose?.()
    }
  }

  private releaseEnvironment() {
    if (this.scene.environment) {
      this.scene.environment = null
    }
    this.scene.environmentIntensity = 1
    this.environmentTarget?.dispose()
    this.environmentTarget = null
    this.pmrem?.dispose()
    this.pmrem = null
  }

  private teardownLights() {
    for (const light of [this.ambient, this.hemisphere, this.key]) {
      if (!light) continue
      this.scene.remove(light)
      light.dispose()
    }
    this.ambient = null
    this.hemisphere = null
    this.key = null
  }
}
