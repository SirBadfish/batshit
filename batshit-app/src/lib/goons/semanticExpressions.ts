import type { GoonExpressionPreset } from '$lib/types/goons'

export type GoonSemanticExpressionControl = {
  value: GoonExpressionPreset
  label: string
}

export type GoonSemanticExpressionControlState = GoonSemanticExpressionControl & {
  available: boolean
  unavailableReason?: string
}

/**
 * Stable Mood/Emote expression vocabulary shared by every Goon lane.
 *
 * A model may support only a subset. Keep the complete vocabulary visible in
 * the editor and mark unsupported controls unavailable instead of silently
 * accepting weights the runtime cannot apply.
 */
export const GOON_SEMANTIC_EXPRESSION_CONTROLS: readonly GoonSemanticExpressionControl[] = [
  { value: 'happy', label: 'Happy' },
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'sad', label: 'Sad' },
  { value: 'angry', label: 'Angry' },
  { value: 'surprised', label: 'Surprised' },
  { value: 'neutral', label: 'Neutral' }
]

export function resolveGoonSemanticExpressionControlStates(
  supportedPresets: ReadonlySet<GoonExpressionPreset>,
  sourceLabel: string
): GoonSemanticExpressionControlState[] {
  return GOON_SEMANTIC_EXPRESSION_CONTROLS.map((control) => {
    const available =
      control.value === 'neutral' || supportedPresets.has(control.value)
    return {
      ...control,
      available,
      ...(available
        ? {}
        : {
            unavailableReason: `${sourceLabel} does not provide a mapped ${control.label} expression.`
          })
    }
  })
}
