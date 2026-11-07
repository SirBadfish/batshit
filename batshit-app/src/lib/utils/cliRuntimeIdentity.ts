/** Saved configuration and existing dispatch predicates only; no native status or readiness. */
import { isClaudePlanSelection } from './claudePlanConnection'
const CLAUDE_CLI_CONNECTION_ID = 'claude-cli'
const CLAUDE_CLI_PROVIDER_IDS: ReadonlySet<string> = new Set(['claude-cli', 'anthropic-claude-cli'])

/**
 * SA-139 R1: Codex CLI was removed (Josh, 2026-10-26). Its ids stay only so a stored or
 * requested Codex CLI identity is RECOGNIZED and refused: it never runs, and it never silently
 * becomes a Claude CLI or an API agent. No record is migrated or rewritten. A model id that
 * merely contains "codex" (an OpenAI model on an API agent or the ChatGPT plan) is not this.
 */
export const RETIRED_CODEX_CLI_CONNECTION_ID = 'codex-cli'
export const RETIRED_CODEX_CLI_PROVIDER_IDS: ReadonlySet<string> = new Set(['codex', 'openai-codex'])
export const CODEX_CLI_RETIRED_CODE = 'codex_cli_retired'
export const CODEX_CLI_RETIRED_ERROR = 'Codex CLI agents were removed from Batshit.'
export const CODEX_CLI_RETIRED_DETAILS =
  'This agent runs on Codex CLI, which Batshit no longer supports. Delete it and create a new agent. ' +
  'For ChatGPT models, use an API agent with the ChatGPT plan connection or an OpenAI API key.'
export const CODEX_CLI_SUBAGENT_RETIRED_DETAILS =
  'This Subagent runs on Codex CLI, which Batshit no longer supports. Delete it and create a new Subagent.'

/**
 * Which CLI lanes a Primary's provider and connection name. `codex` means the RETIRED lane is
 * named (refuse); `claude` means Claude CLI. Callers retain their existing provider
 * normalization and exact connection spelling.
 */
export function primaryCliRuntimeCandidates(provider: string, connection: string | null | undefined) {
  return { codex: RETIRED_CODEX_CLI_PROVIDER_IDS.has(provider) || connection === RETIRED_CODEX_CLI_CONNECTION_ID,
    claude: CLAUDE_CLI_PROVIDER_IDS.has(provider) || connection === CLAUDE_CLI_CONNECTION_ID }
}

export function cliSubagentProviderHint(row: { primary_model_provider?: unknown; primary_model_name?: unknown; model?: unknown }): string {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  return `${text(row.primary_model_provider).toLowerCase()} ${text(row.primary_model_name).toLowerCase() || text(row.model).toLowerCase()}`.trim()
}
/** Same meaning as `primaryCliRuntimeCandidates`, from a CLI Subagent's stored hint. */
export function subagentCliRuntimeCandidates(row: { primary_model_provider?: unknown; primary_model_name?: unknown; model?: unknown; primary_model_connection?: unknown }) {
  // SA-139 (D1): a record that names the Claude plan is an API selection, never the Claude CLI lane.
  const connection = row.primary_model_connection
  if (connection && typeof connection === 'object' && isClaudePlanSelection(connection as { id?: string; service?: string })) return { codex: false, claude: false }
  const hint = cliSubagentProviderHint(row)
  return { codex: hint.includes('codex'), claude: hint.includes('claude-cli') || hint.includes('claude') }
}
/**
 * True when a Primary's saved or requested model fields name the removed Codex CLI by provider
 * or connection id (never by a model-name substring). Create and update routes refuse saving it.
 */
export function namesRetiredCodexCliModel(fields: { primary_model_provider?: unknown; primary_model_connection?: unknown }): boolean {
  const text = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''
  const connection = fields.primary_model_connection && typeof fields.primary_model_connection === 'object'
    ? fields.primary_model_connection as { id?: unknown; service?: unknown } : null
  return RETIRED_CODEX_CLI_PROVIDER_IDS.has(text(fields.primary_model_provider)) ||
    text(connection?.id) === RETIRED_CODEX_CLI_CONNECTION_ID || RETIRED_CODEX_CLI_PROVIDER_IDS.has(text(connection?.service))
}
/**
 * SA-139 R4/R5: the refusal for an agent or Subagent save that names a Claude Code CLI preset.
 * R4 kept those presets for Claude Code CLI Subagents only; R5 removed that type, so nothing
 * runs them. Leftover presets stay readable (and deletable in Settings, Models).
 */
export const CLAUDE_CLI_PRESET_REFUSAL =
  'Claude Code CLI presets were removed from Batshit. Pick another model, for example a Claude plan model.'
/**
 * SA-139 R4/R5: true when saved or requested model fields name a Claude Code CLI preset. No agent
 * or Subagent stores one. Reads the provider, the model and BOTH connection fields, so neither
 * can hide the other.
 */
export function namesClaudeCliModel(fields: { primary_model_provider?: unknown; primary_model_name?: unknown; primary_model_connection?: unknown }): boolean {
  const text = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : ''
  const connection = fields.primary_model_connection && typeof fields.primary_model_connection === 'object'
    ? fields.primary_model_connection as { id?: unknown; service?: unknown } : null
  return [fields.primary_model_provider, fields.primary_model_name, connection?.id, connection?.service]
    .some(value => text(value).includes('claude-cli'))
}
