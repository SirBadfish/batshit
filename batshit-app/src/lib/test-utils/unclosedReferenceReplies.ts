/**
 * 1 MB texts of 20,000 reference openers that no reference can close, for the timing tests of
 * the reference readers (`zipReferenceSafety.ts`). A lazy or unlimited pattern pays (openers) x
 * (text length) on these: seconds to minutes of the one Node process. Each maps a shape name to
 * its text; no text holds a single reference, so every reader must return it unchanged.
 */
export function unclosedReferenceReplies(
  kind: 'zip' | 'clip' | 'legacyClip' | 'toolLoadingPlaceholder'
): Record<string, string> {
  const lines = (opener: string) => (opener + 'x'.repeat(50 - opener.length - 1) + '\n').repeat(20_000)
  if (kind === 'zip') {
    return {
      'zip description never closed, no } at all': lines('{{batshit-zip:zip_1:::desc '),
      'zip description never closed, one lone } at the end': lines('{{batshit-zip:zip_1:::desc ') + '}'
    }
  }
  if (kind === 'toolLoadingPlaceholder') {
    return {
      'tool loading placeholder never closed, no } at all': lines('{{TOOL_LOADING_PLACEHOLDER:tool_1 '),
      'tool loading placeholder never closed, one lone } at the end':
        lines('{{TOOL_LOADING_PLACEHOLDER:tool_1 ') + '}'
    }
  }
  if (kind === 'clip') {
    return {
      'clip description never closed, no } at all': lines('{{batshit-clip:clip_1:::desc '),
      'clip description never closed, one lone } at the end':
        lines('{{batshit-clip:clip_1:::desc ') + '}'
    }
  }
  return {
    'legacy header closed, no closing tag': lines('{{batshit-clip|id:clip_1}} '),
    'legacy header never closed, no } at all': lines('{{batshit-clip|id:clip_1 '),
    'legacy headers share one header end and closing tag, no id':
      lines('{{batshit-clip|name:a ') + '}}{{/batshit-clip}}'
  }
}
