/**
 * The size guard's own notice for a fetchable cut, in the exact words `cutNotice` writes
 * (`$lib/utils/toolModelTextSizeGuard.ts`). BL-678: only this notice, at the end of a text,
 * makes a cut view; a look-alike line is ordinary text. `toolModelTextSizeGuard.test.ts` pins
 * that this helper and the guard agree.
 */
export function guardCutNotice(
  keptChars: number,
  zipId = 'tool_raw_1790000000000_abcd',
  totalChars = 200_000
): string {
  return `[Output cut here by Batshit: this result is about ${Math.ceil(totalChars / 4).toLocaleString('en-US')} tokens (${totalChars.toLocaleString('en-US')} characters). One result can be 25,000 tokens at most. You have the first ${keptChars.toLocaleString('en-US')} characters. Call Fetch Zip with zipId ${zipId} and offset ${keptChars} to read the rest.]`
}
