import type { IconRef } from '$lib/icons/iconTypes'

export type BrokerFamilyGroupIconMode = 'group-only' | 'group+tools+names' | 'group+tools+hints'

/**
 * The Discoverable + Display Detail pair for a broker family that has no gateway and no
 * per-item catalog: Fabric controls and published agent-usable Artifact runtime tools.
 *
 * SA-096. These controls render in two places and must behave identically in both:
 *
 * - Inside the `Batshit Tools` accordion, on the existing `Fabric Controls` /
 *   `Artifact Tools` zip rows, wherever the grid shows zip columns (Global and Agent).
 * - As a standalone top-level row on the discoverability-only surfaces (Subagent
 *   Settings, Chatbar dropdown), which do not render the `Batshit Tools` section at all.
 *
 * One family therefore never appears twice in the same grid.
 */
export interface BrokerFamilyRowControls {
  label: string
  iconRef: IconRef
  visible: boolean
  value: string
  iconMode: BrokerFamilyGroupIconMode
  options: Array<{ value: string; label: string }>
  optionIconMode: (optionValue: string) => BrokerFamilyGroupIconMode
  modeLabel: (optionValue: string) => string
  infoParagraphs: string[]
  disabled?: boolean
  triggerClass?: (optionValue: string) => string
  toneClass?: (optionValue: string) => string
  onVisibleChange: (visible: boolean) => void
  onModeChange: (value: string) => void
}
