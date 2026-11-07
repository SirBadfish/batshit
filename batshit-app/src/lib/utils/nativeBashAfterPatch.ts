import type { ToolApprovalMode } from '$lib/types/tool-approvals'

type BashMode = 'plan' | 'agent' | 'dangerous'
const aliases: Record<string, BashMode> = {
  plan: 'plan', read_only: 'plan', readonly: 'plan', agent: 'agent', workspace: 'agent',
  dangerous: 'dangerous', unrestricted: 'dangerous'
}

export function normalizeNativeBashAccessMode(value: unknown): BashMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return Object.hasOwn(aliases, normalized) ? aliases[normalized] : null
}

function boolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  return undefined
}

function source(providerSettings?: Record<string, any> | null) {
  const settings = providerSettings && typeof providerSettings === 'object' ? providerSettings : {}
  const nested = settings.nativeTools && typeof settings.nativeTools === 'object' ? settings.nativeTools
    : settings.batshitNativeTools && typeof settings.batshitNativeTools === 'object' ? settings.batshitNativeTools : {}
  return { settings, nested }
}

export function nativeBashApprovalCardsEnabled(providerSettings?: Record<string, any> | null): boolean {
  const { settings, nested } = source(providerSettings)
  for (const key of ['bashAgentApprovalCardsEnabled', 'bashApprovalCardsEnabled', 'nativeBashAgentApprovalCardsEnabled', 'nativeBashApprovalCardsEnabled']) {
    for (const row of [nested, settings]) {
      if (!Object.hasOwn(row, key)) continue
      const value = boolean(row[key])
      if (value !== undefined) return value
    }
  }
  return false
}

export function nativeBashApprovalRequestsEnabled(
  settings: { bashAccessMode: BashMode; bashAgentApprovalCardsEnabled: boolean },
  context: { groupMemberRun?: boolean; toolApprovalMode?: ToolApprovalMode } = {}
): boolean {
  return context.groupMemberRun !== true && settings.bashAccessMode === 'agent' &&
    (context.toolApprovalMode ? context.toolApprovalMode === 'all' : settings.bashAgentApprovalCardsEnabled === true)
}

export function nativeBashCommandsAfterPatchRun(mode: BashMode, approvalRequestsEnabled: boolean): boolean {
  return mode === 'dangerous' || mode === 'agent' && approvalRequestsEnabled
}

/** Same mode aliases, approval settings and server turn overrides as native tool registration. */
export function nativeBashAfterPatchFromProvider(
  providerSettings?: Record<string, any> | null,
  context: { groupMemberRun?: boolean; toolApprovalMode?: ToolApprovalMode } = {}
): boolean {
  const { settings, nested } = source(providerSettings)
  const mode = normalizeNativeBashAccessMode(nested.bashAccessMode ?? nested.nativeBashAccessMode ??
    nested.bashPolicyMode ?? settings.nativeBashPolicyMode ?? settings.bashPolicyMode) ?? 'agent'
  return nativeBashCommandsAfterPatchRun(mode, nativeBashApprovalRequestsEnabled({
    bashAccessMode: mode, bashAgentApprovalCardsEnabled: nativeBashApprovalCardsEnabled(providerSettings)
  }, context))
}
