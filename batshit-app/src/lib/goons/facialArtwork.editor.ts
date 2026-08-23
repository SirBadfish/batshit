import {
  createDefaultFacialArtworkState,
  reconcileFacialArtworkState,
  resolveFacialArtworkEyeState,
  type FacialArtworkDefinition,
  type FacialArtworkEyeState,
  type FacialArtworkRoleId,
  type FacialArtworkSide,
  type FacialArtworkState
} from './facialArtwork'

export type FacialArtworkEyeTarget = {
  roleId: FacialArtworkRoleId
  side: FacialArtworkSide
}

export function cloneFacialArtworkState(value: FacialArtworkState): FacialArtworkState {
  return JSON.parse(JSON.stringify(value)) as FacialArtworkState
}

export function restoreFacialArtworkDraft(
  definition: FacialArtworkDefinition,
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
  value: FacialArtworkState,
  roleId: FacialArtworkRoleId,
  mode: 'shared' | 'per-eye',
  collapseSource?: FacialArtworkSide
): FacialArtworkState {
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
  value: FacialArtworkState,
  target: FacialArtworkEyeTarget,
  update: (state: FacialArtworkEyeState) => FacialArtworkEyeState
): FacialArtworkState {
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
