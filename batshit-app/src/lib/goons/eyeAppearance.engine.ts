import {
  resolveEyeAppearanceRuntimeControlValue,
  resolveEyeAppearanceState,
  type EyeAppearanceDefinition,
  type EyeAppearanceState
} from './eyeAppearance'
import type { SocketEyeSide } from './socketEyeSurface'

export type SocketEyePhysicalVisualState = {
  irisRadiusMeters: number
  pupilRadiusRatio: number
  irisHorizontalOffsetMeters: number
  irisVerticalOffsetMeters: number
  edgeSoftnessMeters: number
  cornea: {
    roughness: number
    clearcoat: number
    clearcoatRoughness: number
  }
}

function fail(message: string): never {
  throw new Error(`[eye-appearance/runtime-v5] ${message}`)
}

/**
 * Eye Appearance v5 owns presentation values only. The physical sphere remains
 * transform-fitted, while Iris/Pupil move in gaze-linked material coordinates.
 * Eye Highlight is independently fixed in front/cornea space.
 */
export class EyeAppearanceEngineRuntime {
  private state: EyeAppearanceState
  private disposed = false

  constructor(
    readonly definition: EyeAppearanceDefinition,
    initialState: EyeAppearanceState | null,
    private readonly onChange?: () => void
  ) {
    this.state = resolveEyeAppearanceState(definition, initialState)
  }

  getState(): EyeAppearanceState {
    return { ...this.state }
  }

  setState(value: EyeAppearanceState | null) {
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
    const irisHorizontalPosition = resolveEyeAppearanceRuntimeControlValue(
      this.definition,
      'iris_horizontal_position',
      this.state.irisHorizontalPosition
    )
    // Batshit Head-local anatomy places the Goon's left eye on +X and right on -X.
    // Positive user state therefore converges by moving left toward -X and right toward +X.
    const inwardSign = side === 'left' ? -1 : 1
    return {
      irisRadiusMeters: binding.irisNeutralRadiusMeters * irisMultiplier,
      pupilRadiusRatio: binding.pupilNeutralRadiusRatio * pupilMultiplier,
      irisHorizontalOffsetMeters:
        inwardSign *
        binding.irisHorizontalTravelMeters *
        (binding.neutralPlacement.horizontalTravelFraction + irisHorizontalPosition),
      irisVerticalOffsetMeters:
        binding.irisVerticalTravelMeters *
        (binding.neutralPlacement.verticalTravelFraction + irisVerticalPosition),
      edgeSoftnessMeters: binding.edgeSoftnessMeters,
      cornea: { ...binding.cornea }
    }
  }

  dispose() {
    this.disposed = true
  }
}
