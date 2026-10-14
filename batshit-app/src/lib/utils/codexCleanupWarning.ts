/** Server-owned text for a stopped Codex command whose cleanup is unconfirmed. */
export const CODEX_CLEANUP_WARNING_TEXT =
  'Batshit could not confirm that a command from this reply stopped. It may still be running. If it is, end the program yourself or restart your computer.'

export const CODEX_RECORDED_PROCESSES_ENDED_TEXT =
  'Batshit verified that each program it recorded for the old run has ended. Commands that the old run started without a record may still run until they end or the computer restarts.'

export type CodexCleanupWarningKind = 'unconfirmed_command_cleanup' | 'recorded_processes_ended'

export interface CodexCleanupWarning {
  messageId: string
  kind: CodexCleanupWarningKind
}

export function codexCleanupWarningText(kind: CodexCleanupWarningKind): string {
  return kind === 'recorded_processes_ended'
    ? CODEX_RECORDED_PROCESSES_ENDED_TEXT
    : CODEX_CLEANUP_WARNING_TEXT
}

export function readCodexCleanupWarning(value: unknown, messageId: string): CodexCleanupWarning | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return record.messageId === messageId &&
    (record.kind === 'unconfirmed_command_cleanup' || record.kind === 'recorded_processes_ended')
    ? { messageId, kind: record.kind }
    : null
}
