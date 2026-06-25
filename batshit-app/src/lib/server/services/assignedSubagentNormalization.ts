import { normalizeSubagentType } from '$lib/utils/subagentType'

type RawSubagent = Record<string, any>

export function normalizeAssignedSubagent(raw: RawSubagent): any {
  const displayName = raw.displayName || raw.display_name || raw.name || raw.id
  const includeClaude = raw.include_claude_cli === true
  const includeBatshit = raw.include_batshit_subagent === true
  const includeGlobal = raw.include_global_prompt !== false
  const workflowName =
    raw.workflowName ||
    raw.workflow_name ||
    raw.webhookUrl ||
    raw.webhook_url ||
    ''
  const subagentType = normalizeSubagentType(raw, raw.subagentType || raw.subagent_type)
  const defaultMCPGateways =
    raw.defaultMCPGateways ||
    raw.default_mcp_gateways ||
    raw.defaultGateways ||
    raw.default_gateways ||
    []
  const defaultMCPToolSelections =
    raw.defaultMCPToolSelections || raw.default_mcp_tool_selections || []
  const defaultTools = raw.defaultTools || raw.default_tools || []
  const dcmDisplaySettings =
    raw.dcmDisplaySettings || raw.dcm_display_settings || null
  const avatar = raw.avatar || raw.avatarUrl || undefined
  const primary_model_provider =
    raw.primary_model_provider || raw.provider || null
  const primary_model_name =
    raw.primary_model_name || raw.model || null

  return {
    id: raw.id,
    name: raw.name || displayName,
    displayName,
    description: raw.description,
    primary_model_provider,
    primary_model_name,
    provider_specific_settings: raw.provider_specific_settings ?? null,
    codex_settings: raw.codex_settings ?? null,
    claude_settings: raw.claude_settings ?? null,
    avatar,
    workflowName,
    webhookUrl: raw.webhookUrl || raw.webhook_url || workflowName || undefined,
    subagentType,
    type: includeClaude
      ? 'claude_cli'
      : includeBatshit
        ? 'standard_agent'
        : 'standard_agent',
    include_claude_cli: includeClaude,
    include_batshit_subagent: includeBatshit,
    include_global_prompt: includeGlobal,
    system_prompt: raw.system_prompt,
    settings: {
      system_prompt: raw.system_prompt,
      primary_model_provider,
      primary_model_name,
      primary_model_temperature: raw.primary_model_temperature,
      primary_model_max_tokens: raw.primary_model_max_tokens,
      primary_model_top_p: raw.primary_model_top_p,
      include_global_prompt: includeGlobal,
      provider_specific_settings: raw.provider_specific_settings ?? null,
      codex_settings: raw.codex_settings ?? null,
      claude_settings: raw.claude_settings ?? null,
    },
    defaultMCPGateways,
    defaultMCPToolSelections,
    defaultTools,
    dcmDisplaySettings,
  }
}
