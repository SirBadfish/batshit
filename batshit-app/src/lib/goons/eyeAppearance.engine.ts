import {
  resolveEyeAppearanceRuntimeControlValue,
  resolveEyeAppearanceState,
  type EyeAppearanceDefinitionV3,
  type EyeAppearanceStateV3
} from './eyeAppearance'
import type { SocketEyeSide } from './socketEyeSurface'

export type SocketEyePhysicalVisualState = {
  irisRadiusMeters: number
  pupilRadiusRatio: number
  irisVerticalOffsetMeters: number
  edgeSoftnessMeters: number
  cornea: {
    roughness: number
    clearcoat: number
    clearcoatRoughness: number
  }
}

function fail(message: string): never {
  throw new Error(`[eye-appearance/runtime-v3] ${message}`)
}

/**
 * Eye Appearance v3 owns presentation values only. It never moves geometry,
 * eye bones, inverse binds, or Recipe output; the socket-eye material consumes
 * this resolved state together with Facial Artwork v4.
 */
export class EyeAppearanceEngineRuntime {
  private state: EyeAppearanceStateV3
  private disposed = false

  constructor(
    readonly definition: EyeAppearanceDefinitionV3,
    initialState: EyeAppearanceStateV3 | null,
    private readonly onChange?: () => void
  ) {
    this.state = resolveEyeAppearanceState(definition, initialState)
  }

  getState(): EyeAppearanceStateV3 {
    return { ...this.state }
  }

  setState(value: EyeAppearanceStateV3 | null) {
    if (this.disposed) fail('cannot update state after disposal')
    this.state = resolveEyeAppearanceState(this.definition, value)
    this.onChange?.()
  }

  resolveSide(side: SocketEyeSide): SocketEyePhysicalVisualState {
    if (this.disposed) fail('cannot resolve presentation state after disposal')
    const binding = this.definition.runtimeBindings[side]
    const irisMultiplier = resolveEyeAppearanceRuntimeControlValue(
      this.definition,
      'iris_size',
      this.state.irisSize
    )
    const pupilMultiplier = resolveEyeAppearanceRuntimeControlValue(
      this.definition,
      'pupil_size',
      this.state.pupilSize
    )
    const irisVerticalPosition = resolveEyeAppearanceRuntimeControlValue(
      this.definition,
      'iris_vertical_position',
      this.state.irisVerticalPosition
    )
    return {
      irisRadiusMeters: binding.irisNeutralRadiusMeters * irisMultiplier,
      pupilRadiusRatio: binding.pupilNeutralRadiusRatio * pupilMultiplier,
      irisVerticalOffsetMeters:
        binding.irisVerticalTravelMeters * irisVerticalPosition,
      edgeSoftnessMeters: binding.edgeSoftnessMeters,
      cornea: { ...binding.cornea }
    }
  }

  dispose() {
    this.disposed = true
  }
}
