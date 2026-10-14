/**
 * BL-499: a Claude CLI tool on/off switch (Agent Settings' "Allow Claude Web Search") must be
 * driven by `disallowedTools` alone, and must never read or write `allowedTools`.
 *
 * Claude Code's `--allowedTools` only skips the permission prompt for the tools it names; it is
 * not an allowlist that gates every other tool off. A tool absent from it still runs normally
 * (and `Read`/`WebSearch`/`WebFetch` are auto-allowed by Batshit's permission helper,
 * `scripts/claude-permission-mcp.cjs`, unless they are denied). So a switch that also consulted `allowedTools` could show OFF for a tool that was
 * still fully working the moment any OTHER entry existed under Allowed Tools, and turning it OFF
 * in that state could silently erase an existing `disallowedTools` denial instead of adding one
 * (both fields were rewritten together from one stale computation). See
 * `claude-code-integration.md` for the full allow/disallow contract.
 */

export function hasClaudeToolEntry(list: readonly string[], toolName: string): boolean {
  const normalizedTool = toolName.trim().toLowerCase()
  return list.some((entry) => entry.trim().toLowerCase() === normalizedTool)
}

/** Whether `toolName` is enabled: not explicitly denied. `allowedTools` is never consulted. */
export function isClaudeToolEnabled(disallowedTools: readonly string[], toolName: string): boolean {
  return !hasClaudeToolEntry(disallowedTools, toolName)
}

/**
 * The next `disallowedTools` list for turning `toolName` on or off. Returns the SAME array
 * reference when nothing needs to change, so a caller can skip an update. Never touches
 * `allowedTools` — the caller must not read or write it from this switch either.
 */
export function withClaudeToolEnabled(
  disallowedTools: readonly string[],
  toolName: string,
  enabled: boolean
): string[] {
  // Callers pass their own mutable array; handing the identical reference back on a no-op (never
  // a copy) is what lets `updateClaudeForm`'s caller skip a state write.
  const same = disallowedTools as string[]
  const normalizedTool = toolName.trim()
  if (!normalizedTool) return same

  if (enabled) {
    if (!hasClaudeToolEntry(disallowedTools, normalizedTool)) return same
    return disallowedTools.filter(
      (entry) => entry.trim().toLowerCase() !== normalizedTool.toLowerCase()
    )
  }

  if (hasClaudeToolEntry(disallowedTools, normalizedTool)) return same
  return [...disallowedTools, normalizedTool]
}
