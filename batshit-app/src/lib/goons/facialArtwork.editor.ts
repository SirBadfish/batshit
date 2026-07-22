import {
  createDefaultFacialArtworkState,
  reconcileFacialArtworkState,
  resolveFacialArtworkEyeState,
  type FacialArtworkDefinitionV4,
  type FacialArtworkEyeState,
  type FacialArtworkRoleId,
  type FacialArtworkSide,
  type FacialArtworkStateV4
} from './facialArtwork'

export type FacialArtworkEyeTarget = {
  roleId: FacialArtworkRoleId
  side: FacialArtworkSide
}

export function cloneFacialArtworkState(value: FacialArtworkStateV4): FacialArtworkStateV4 {
  return JSON.parse(JSON.stringify(value)) as FacialArtworkStateV4
}

export function restoreFacialArtworkDraft(
  definition: FacialArtworkDefinitionV4,
  value: unknown
) {
  const reconciliation = reconcileFacialArtworkState(definition, value)
  return {
    state: reconciliation.state
      ? cloneFacialArtworkState(reconciliation.state)
      : createDefaultFacialArtworkState(definition),
    incompatible: reconciliation.incompatible,
    reason: reconciliation.reason
  }
}

export function setFacialArtworkRoleMode(
  value: FacialArtworkStateV4,
  roleId: FacialArtworkRoleId,
  mode: 'shared' | 'per-eye',
  collapseSource?: FacialArtworkSide
): FacialArtworkStateV4 {
  const next = cloneFacialArtworkState(value)
  const current = next.roles[roleId]
  if (current.mode === mode) return next
  if (mode === 'per-eye') {
    const shared = current.mode === 'shared' ? current.shared : current.left
    next.roles[roleId] = {
      mode: 'per-eye',
      left: JSON.parse(JSON.stringify(shared)) as FacialArtworkEyeState,
      right: JSON.parse(JSON.stringify(shared)) as FacialArtworkEyeState
    }
  } else {
    let shared = current.mode === 'per-eye' ? current.left : current.shared
    if (current.mode === 'per-eye') {
      const identical = JSON.stringify(current.left) === JSON.stringify(current.right)
      if (!identical && !collapseSource) {
        throw new Error(
          'Choose the left or right eye before collapsing different artwork into Same for both.'
        )
      }
      shared = current[collapseSource ?? 'left']
    }
    next.roles[roleId] = {
      mode: 'shared',
      shared: JSON.parse(JSON.stringify(shared)) as FacialArtworkEyeState
    }
  }
  return next
}

export function updateFacialArtworkEyeState(
  value: FacialArtworkStateV4,
  target: FacialArtworkEyeTarget,
  update: (state: FacialArtworkEyeState) => FacialArtworkEyeState
): FacialArtworkStateV4 {
  const next = cloneFacialArtworkState(value)
  const role = next.roles[target.roleId]
  if (role.mode === 'shared') {
    role.shared = update(role.shared)
  } else {
    role[target.side] = update(role[target.side])
  }
  return next
}

export { resolveFacialArtworkEyeState }
