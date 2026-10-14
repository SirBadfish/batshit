import type { AddressSourcePiece } from './imageAddressOrigin'
import { replaceTextRanges } from './hydratedTextRanges'

/** Ephemeral compiler positions, never part of model messages or saved user data. */
export type PositionedAddressSource = AddressSourcePiece & { start: number; end: number }

export function replaceAddressSourceRanges(
  pieces: readonly PositionedAddressSource[], start: number, end: number, replacement: string,
  inserted?: AddressSourcePiece
): PositionedAddressSource[] {
  const next = pieces.flatMap((piece) => replaceTextRanges([piece],start,end,replacement.length)
    .map((range) => ({...piece,...range})))
  if(inserted && replacement.length) next.push({...inserted,start,end:start+replacement.length})
  return next
}

export function materializeAddressSources(content: string, pieces: readonly PositionedAddressSource[]): AddressSourcePiece[] {
  return pieces.filter((piece)=>piece.end>piece.start).map((piece)=>({
    source:piece.source,text:content.slice(piece.start,piece.end),
    ...(piece.messageId ? {messageId:piece.messageId} : {})
  }))
}
