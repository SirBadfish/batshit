import type { GoonClosetAssignment, GoonGuidedOutfitPiece } from '$lib/types/goons'

function normalizeAvailableSlotNames(availableSlotNames: Iterable<string>) {
  return new Set(
    Array.from(availableSlotNames)
      .map((slotName) => slotName.trim())
      .filter(Boolean)
  )
}

export function resolveGuidedOutfitManagedSlotName(
  piece: GoonGuidedOutfitPiece,
  availableSlotNames: Iterable<string>
) {
  if (piece.source === 'duf-overlay') return null
  const availableSlots = normalizeAvailableSlotNames(availableSlotNames)
  for (const materialName of piece.materialNames ?? []) {
    const slotName = materialName.trim()
    if (slotName && availableSlots.has(slotName)) {
      return slotName
    }
  }
  return null
}

export function isGuidedOutfitPieceSlotManaged(
  piece: GoonGuidedOutfitPiece,
  availableSlotNames: Iterable<string>
) {
  return Boolean(resolveGuidedOutfitManagedSlotName(piece, availableSlotNames))
}

export function resolveGuidedOutfitPieceVisible(
  piece: GoonGuidedOutfitPiece,
  args: {
    availableSlotNames: Iterable<string>
    pieceStates?: Record<string, boolean>
    assignments?: Record<string, GoonClosetAssignment>
  }
) {
  if (piece.source === 'duf-overlay') return true
  const slotName = resolveGuidedOutfitManagedSlotName(piece, args.availableSlotNames)
  if (slotName) {
    return args.assignments?.[slotName]?.mode !== 'none'
  }
  return args.pieceStates?.[piece.id] ?? piece.defaultOn ?? true
}

export function buildGuidedOutfitPieceStates(
  pieces: GoonGuidedOutfitPiece[],
  args: {
    availableSlotNames: Iterable<string>
    pieceStates?: Record<string, boolean>
    assignments?: Record<string, GoonClosetAssignment>
  }
) {
  return Object.fromEntries(
    pieces.map((piece) => [piece.id, resolveGuidedOutfitPieceVisible(piece, args)])
  )
}

export function listStandaloneGuidedOutfitPieces(
  pieces: GoonGuidedOutfitPiece[],
  availableSlotNames: Iterable<string>
) {
  return pieces.filter(
    (piece) =>
      piece.source !== 'duf-overlay' && !isGuidedOutfitPieceSlotManaged(piece, availableSlotNames)
  )
}
