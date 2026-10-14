/**
 * The reply end's text sanitizer: `sanitizeAssistantContent` runs on the rebuild of a reply's
 * stream record and on the server's own copy (`replyStreamRecord.ts`), and since BL-775 its output
 * is the stored reply for every reply, watched or not. So it removes only what Batshit itself put
 * in the text: the tool loading placeholders (with tool artifacts), runs of blank lines, and the
 * outer whitespace.
 *
 * BL-775 removed four cuts from SA-Code-02 (Oct 2025), written for the n8n Primary agent, whose
 * LangChain output echoed its own trace after the answer: a reply with tool artifacts was cut at
 * its first line starting `Tool:` or `Intermediate steps:`, lost every line starting `AI:`, and
 * lost a trailing JSON block with a tool-looking key (`toolName`, `error`, ...). That lane is
 * retired (SA-106) and no managed lane writes such a trace, so each cut could only take an
 * agent's own words (the same class as BL-548's retired webhook guard).
 */
import { replaceBracedTokens } from '$lib/utils/braceScan'

export function sanitizeAssistantContent(raw: string, hasToolArtifacts: boolean): string {
  if (!raw) {
    return raw
  }

  let content = raw

  if (hasToolArtifacts) {
    // BL-707: one scan, the pattern's own rules (`braceScan.ts`).
    content = replaceBracedTokens(content, '{{TOOL_LOADING_PLACEHOLDER:', () => '')
  }

  content = content.replace(/\n{3,}/g, '\n\n')

  return content.trim()
}
