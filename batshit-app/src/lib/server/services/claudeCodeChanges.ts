/**
 * SA-139: a count of changes to Claude Code itself (a managed install, reinstall or uninstall from
 * `POST /api/cli-runtimes`). The Claude plan's shared display read (`claudePlanReadiness.ts`) looks
 * again when it moves, so the card and pickers refreshed by the install card's event never show the
 * status from before the change. Kept apart so the install route need not load the plan's readers.
 */
let changes = 0

export function noteClaudeCodeChanged(): void {
  changes += 1
}

export function claudeCodeChangeCount(): number {
  return changes
}
