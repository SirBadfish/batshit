import type {
  GoonClosetAssignment,
  GoonClosetItem,
  GoonClosetOriginalSource,
  GoonGuidedOutfitPiece,
  GoonPaintedConcealMask
} from '$lib/types/goons'
import { normalizePaintedConcealMask } from '$lib/goons/paintedConcealMasks'

const GUIDED_PIECE_ORIGINAL_CLOSET_SLOT_PREFIX = '__guided_piece_original__'

export function buildGuidedPieceOriginalClosetSlot(pieceId: string) {
  return `${GUIDED_PIECE_ORIGINAL_CLOSET_SLOT_PREFIX}:${pieceId.trim()}`
}

export function parseGuidedPieceOriginalClosetSlot(slotName: string) {
  if (!slotName.startsWith(`${GUIDED_PIECE_ORIGINAL_CLOSET_SLOT_PREFIX}:`)) return null
  const pieceId = slotName.slice(GUIDED_PIECE_ORIGINAL_CLOSET_SLOT_PREFIX.length + 1).trim()
  return pieceId || null
}

function addPaintedMaskToList(target: GoonPaintedConcealMask[], mask: GoonPaintedConcealMask | null | undefined) {
  const normalized = normalizePaintedConcealMask(mask)
  if (!normalized) return
  target.push(normalized)
}

function buildGuidedPiecesBySlot(guidedOutfitPieces: GoonGuidedOutfitPiece[]) {
  const piecesBySlot = new Map<string, GoonGuidedOutfitPiece[]>()
  for (const piece of guidedOutfitPieces) {
    for (const materialName of piece.materialNames ?? []) {
      const slotName = materialName.trim()
      if (!slotName) continue
      const bucket = piecesBySlot.get(slotName) ?? []
      bucket.push(piece)
      piecesBySlot.set(slotName, bucket)
    }
  }
  return piecesBySlot
}

function isGuidedPieceVisible(
  piece: GoonGuidedOutfitPiece | null | undefined,
  guidedPieceStates: Record<string, boolean>
) {
  if (!piece) return false
  return guidedPieceStates[piece.id] ?? piece.defaultOn ?? true
}

export function resolveActiveWearableConceal(args: {
  closetAssignments?: Record<string, GoonClosetAssignment>
  resolveClosetItem?: (itemId?: string | null) => GoonClosetItem | null
  resolveOriginalSavedItem?: (source: GoonClosetOriginalSource) => GoonClosetItem | null
  guidedOutfitPieces?: GoonGuidedOutfitPiece[]
  guidedPieceStates?: Record<string, boolean>
}) {
  const closetAssignments = args.closetAssignments ?? {}
  const guidedOutfitPieces = args.guidedOutfitPieces ?? []
  const guidedPieceStates = args.guidedPieceStates ?? {}
  const paintedMasks: GoonPaintedConcealMask[] = []
  const piecesBySlot = buildGuidedPiecesBySlot(guidedOutfitPieces)

  for (const piece of guidedOutfitPieces) {
    const visible = isGuidedPieceVisible(piece, guidedPieceStates)
    if (!visible) continue
    if ((piece.materialNames?.length ?? 0) > 0) continue
    const savedOriginal = args.resolveOriginalSavedItem?.({
      kind: 'guided-piece-original',
      pieceId: piece.id
    })
    addPaintedMaskToList(paintedMasks, savedOriginal?.paintedConcealMask)
  }

  const slotNames = new Set([...Object.keys(closetAssignments), ...piecesBySlot.keys()])
  for (const slotName of slotNames) {
    const assignment = closetAssignments[slotName] ?? ({ mode: 'original' } satisfies GoonClosetAssignment)
    if (assignment.mode === 'none') continue
    const virtualGuidedPieceId = parseGuidedPieceOriginalClosetSlot(slotName)
    if (virtualGuidedPieceId) {
      const piece = guidedOutfitPieces.find((entry) => entry.id === virtualGuidedPieceId)
      if (!isGuidedPieceVisible(piece, guidedPieceStates)) continue
    }

    if (assignment.mode === 'item') {
      const item = args.resolveClosetItem?.(assignment.itemId)
      addPaintedMaskToList(paintedMasks, item?.paintedConcealMask)
      continue
    }

    if (virtualGuidedPieceId) {
      const savedOriginal = args.resolveOriginalSavedItem?.({
        kind: 'guided-piece-original',
        pieceId: virtualGuidedPieceId
      })
      addPaintedMaskToList(paintedMasks, savedOriginal?.paintedConcealMask)
      continue
    }

    const savedOriginal = args.resolveOriginalSavedItem?.({
      kind: 'slot-original',
      slotName
    })
    addPaintedMaskToList(paintedMasks, savedOriginal?.paintedConcealMask)
  }

  return {
    paintedMasks
  }
}
