// Database types for Redis storage
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { CodexAgentSettings } from '$lib/types/codex'
import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { GroupChatAgentSettings, GroupChatZipSettings } from '$lib/types/groupChat'
import type { AgentVoiceProfile, VoiceSettings } from '$lib/types/voice'
import type { GoonsSettings, GoonRecord } from '$lib/types/goons'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { StoredPrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { StoredSubagentType } from '$lib/utils/subagentType'
import type {
  AgentAutoCompactSettings,
  GlobalAutoCompactSettings
} from '$lib/utils/contextCompaction'

export interface ChatFolderRow {
  id: string
  user_id: string
  name: string
  is_default: boolean  // True for the default folder that can't be deleted
  is_expanded: boolean  // UI state for accordion
  sort_order: number  // For ordering folders
  icon_ref?: IconRef | null
  last_used_at?: string
  created_at: string
  updated_at?: string
  chat_count?: number  // Computed field for UI (not stored in Redis)
}

export interface ChatSessionRow {
  id: string
  user_id?: string
  name?: string
  created_at: string
  last_modified_at: string
  metadata?: Record<string, any>
  archived?: boolean
  archived_at?: string | null
  locked?: boolean
  agent_id?: string
  folder_id?: string  // Every chat belongs to a folder
}

export interface GroupChatGroupRow {
  id: string
  user_id: string
  name: string
  avatar_url?: string | null
  avatar_icon_ref?: IconRef | null
  avatar_icon_fit?: AvatarIconFit | null
  description?: string
  agent_ids: string[]
  agent_settings?: Record<string, GroupChatAgentSettings>
  group_system_prompt?: string
  max_followups_total?: number
  max_agents?: number
  driver_mode?: boolean
  driver_agent_id?: string | null
  shared_tools?: string[]
  zip_settings?: GroupChatZipSettings | null
  created_at: string
  updated_at: string
}

export interface ChatMemoryRow {
  id: string
  session_id: string
  user_id: string
  agent_id?: string
  model_id?: string  // Track which model was used for this message
  model?: string
  provider?: string
  role: 'user' | 'assistant' | 'system'
  status?: 'complete' | 'in_progress' | 'error'
  content?: string  // Now contains embedded zips!
  zipMetadata?: Array<{  // Track which parts are from zips
    zipId: string
    zipType: string
    startIndex: number  // Where in content this zip's expanded content starts
    endIndex: number    // Where it ends
    tokens: number      // Token count for threshold check
    threshold: number   // Threshold for this zip type
    bufferSize: number  // Buffer size for this zip type
  }>
  toolResults?: Array<{  // NEW: Store tool execution results
    id?: string
    type: 'tool' | 'tool_error'
    toolName: string
    toolArgs?: any
    result?: any
    timestamp?: string
    tokens?: number
    zipId?: string
    status?: 'success' | 'error'
    error?: string
  }>
  intermediateSteps?: Array<any>  // Store raw tool execution data from n8n
  toolPlaceholders?: string[]  // Track tool execution placeholders
  toolPreface?: string  // Original content before tool placeholders
  originalcreatedat?: string
  metadata?: Record<string, any>
  created_at: string
}

export interface AgentRow {
  id: string
  user_id: string
  displayName: string
  description?: string
  webhook_url?: string
  webhookUrl?: string  // Backward compatibility - same as webhook_url
  agent_url?: string  // Keep for n8n reference
  default_project_id?: string | null
  avatar?: string | null  // URL to avatar image
  avatar_url?: string | null  // Mapped from avatar for consistency
  avatar_icon_ref?: IconRef | null  // Icon-picker alternative to uploaded avatar
  avatar_icon_fit?: AvatarIconFit | null  // Avatar-only display fit for icon-picker avatars
  system_prompt?: string
  model?: string

  // Canonical primary-agent contract (SA-061)
  agentType?: StoredPrimaryAgentType
  slug?: string

  // System prompt toggles
  include_global_prompt?: boolean  // Default: true
  // Default enabled CLI tool ids for the agent (SA-050)
  defaultTools?: string[] | null
  // Default MCP gateways for the agent (Story 5.22)
  defaultMCPGateways?: string[]  // Gateway IDs to load automatically in Mode 3
  // Default enabled MCP tools (SA-009: Flat list of tool names)
  // Simple model: if tool is in list = enabled, if not = disabled
  defaultMCPToolSelections?: string[]
  // SA-039: Agent-level Dynamic MCP DCM display preferences
  dcmDisplaySettings?: AgentDcmDisplaySettings
  // Assigned subagents (Story 6.8 → Architecture Simplification)
  assignedSubagents?: string[]  // Subagent IDs assigned to this agent
  // Zipping settings
  buffer_size?: number
  buffer_size_image?: number
  auto_zip_error?: boolean
  auto_zip_image?: boolean
  auto_zip_subagent?: boolean
  zip_disabled_error?: boolean
  zip_disabled_image?: boolean
  zip_disabled_subagent?: boolean
  zip_control_mode?: 'user' | 'agent' | null  // DEPRECATED (legacy agent-managed toggle)
  zip_agent_control_enabled?: boolean | null
  zip_ai_view_mode?: 'inline' | 'appended' | null
  zip_tool_notes_enabled?: boolean | null
  zip_threshold_error?: number
  zip_threshold_image?: number
  // Per-type buffer settings
  buffer_size_error?: number

  // SA-104: per-agent memory enablement (DL-104-16). Default false; resolved only
  // through resolveAgentMemoryEnabled(). The Settings toggle ships in P5.
  memory_enabled?: boolean | null

  // SA-111 P4: per-agent Workers enablement (DL-111-11). Default ON for API and CLI
  // primaries; resolved only through resolveWorkersEnabled().
  workers_enabled?: boolean | null

  // Reasoning / thinking rendering (SA-018)
  show_reasoning?: boolean
  preserve_reasoning?: boolean

  // Tool approval gating for API/CLI primary agents
  tool_approval_mode?: 'off' | 'all'

  // Permanent context compaction controls
  auto_compact_settings?: AgentAutoCompactSettings | null
  
  // Voice profile (Story 7.8)
  voice_profile?: AgentVoiceProfile

  // 3D Goons (Story 7.9)
  goon_id?: string | null

  // Granular tool-specific settings
  // File operations
  buffer_size_read_file?: number
  zip_threshold_read_file?: number
  buffer_size_write_file?: number
  zip_threshold_write_file?: number
  buffer_size_edit_file?: number
  zip_threshold_edit_file?: number
  
  // Command execution
  buffer_size_execute_command?: number
  zip_threshold_execute_command?: number
  
  // Listing operations
  buffer_size_list_files?: number
  zip_threshold_list_files?: number
  
  // All other tools fallback
  buffer_size_all_other_tools?: number
  zip_threshold_all_other_tools?: number
  auto_zip_read_file?: boolean
  auto_zip_write_file?: boolean
  auto_zip_edit_file?: boolean
  auto_zip_execute_command?: boolean
  auto_zip_list_files?: boolean
  auto_zip_all_other_tools?: boolean
  zip_disabled_read_file?: boolean
  zip_disabled_write_file?: boolean
  zip_disabled_edit_file?: boolean
  zip_disabled_execute_command?: boolean
  zip_disabled_list_files?: boolean
  zip_disabled_all_other_tools?: boolean

  // Subagent conversation settings (call_subagent)
  buffer_size_subagent?: number
  zip_threshold_subagent?: number

  // Custom tool settings - user-defined
  custom_tool_settings?: Array<{
    tool_name: string
    buffer_size?: number
    zip_threshold?: number
    auto_zip?: boolean
    zip_disabled?: boolean
  }>
  
  // Track which settings have been overridden from global defaults
  overridden_settings?: string[]  // e.g. ['buffer_size_terminal', 'zip_threshold_error']
  
  // AI Provider settings
  primary_model_provider?: string
  primary_model_name?: string
  primary_model_preset_id?: string
  primary_model_temperature?: number
  primary_model_max_tokens?: number
  primary_model_top_p?: number
  primary_model_top_k?: number
  primary_model_frequency_penalty?: number
  primary_model_presence_penalty?: number
  primary_model_capabilities?: ModelCapabilities | null
  primary_model_connection?: ModelConnectionInfo | null
  primary_model_seed?: number
  primary_model_stop_sequences?: string[]
  primary_model_reasoning_effort?: string
  provider_specific_settings?: Record<string, any>
  fallback_model_enabled?: boolean
  fallback_model_provider?: string
  fallback_model_name?: string
  fallback_model_preset_id?: string
  fallback_model_connection?: ModelConnectionInfo | null
  fallback_model_temperature?: number
  fallback_model_max_tokens?: number
  fallback_model_top_p?: number
  fallback_model_top_k?: number
  fallback_model_frequency_penalty?: number
  fallback_model_presence_penalty?: number
  fallback_model_seed?: number
  fallback_model_stop_sequences?: string[]
  fallback_model_reasoning_effort?: string
  fallback_model_capabilities?: ModelCapabilities | null
  fallback_provider_specific_settings?: Record<string, any>
  custom_model_settings?: string  // Advanced key=value pairs for power users
  ai_permissions?: any  // JSONB
  assigned_subagent_ids?: string[]  // Track which subagents are assigned to this agent
  codex_settings?: CodexAgentSettings | null
  claude_settings?: ClaudeAgentSettings | null
  created_at: string
  updated_at: string
}

export interface ProjectRow {
  id: string
  user_id: string
  name: string
  full_path: string
  ai_rules?: string
  max_depth?: number
  custom_exclusions?: string[]
  icon_ref?: IconRef | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ProjectPreferences {
  user_id: string
  default_workspace_path?: string
  created_at: string
  updated_at: string
}

export interface ModeRow {
  id: string
  user_id?: string
  name: string
  type: 'simple' | 'boss' | 'custom'
  model?: string
  system_prompt?: string
  is_active: boolean
  is_global: boolean
  created_at: string
  updated_at: string
}

export interface UserSettingsRow {
  id: string
  user_id: string
  displayName?: string
  avatar_url?: string | null
  avatar_icon_ref?: IconRef | null
  avatar_icon_fit?: AvatarIconFit | null
  default_workspace_path?: string
  ui_settings?: Record<string, any>
  upload_settings?: Record<string, any>
  admin_settings?: {
    dcm_schema_hint_required_limit?: number
    dcm_schema_hint_optional_limit?: number
    dcm_schema_hint_max_chars?: number
    dcm_tool_name_threshold?: number
    goon_lip_sync_lab_enabled?: boolean
    web_search_default_provider?: 'duckduckgo-html' | 'exa' | 'perplexity'
    web_search_exa_type?: 'auto' | 'fast' | 'neural' | 'deep'
    web_search_perplexity_max_tokens_per_page?: number
  }
  onboarding_settings?: {
    setup_completed_at?: string | null
    setup_skipped_at?: string | null
    last_seen_step?: 'api-keys' | 'models' | 'agents' | null
  }
  // DEPRECATED - will be removed after migration
  always_show_zip_borders?: boolean
  global_custom_system_prompt?: string
  upload_provider?: string  // Legacy field for backward compatibility
  
  // Visual indicator settings (8 granular controls)
  show_zipped_badges?: boolean
  zipped_badges_hover_only?: boolean
  show_zipped_borders?: boolean
  zipped_borders_hover_only?: boolean
  show_unzipped_badges?: boolean
  unzipped_badges_hover_only?: boolean
  show_unzipped_borders?: boolean
  unzipped_borders_hover_only?: boolean
  
  // Global zip configuration (defaults for all agents)
  global_zip_settings?: {
    // Universal shortcuts
    buffer_size?: number
    zip_threshold?: number

    // Agent zip control permission (default for agents)
    zip_agent_control_enabled?: boolean

    // AI zip layout (inline vs appended)
    zip_ai_view_mode?: 'inline' | 'appended'

    // Tool Notes enable/disable
    zip_tool_notes_enabled?: boolean
    
    // AI Content Blocks
    auto_zip_error?: boolean
    auto_zip_image?: boolean
    auto_zip_subagent?: boolean
    zip_disabled_error?: boolean
    zip_disabled_image?: boolean
    zip_disabled_subagent?: boolean
    buffer_size_error?: number
    zip_threshold_error?: number
    buffer_size_image?: number
    zip_threshold_image?: number
    buffer_size_subagent?: number
    zip_threshold_subagent?: number
    
    // Tool-specific settings
    buffer_size_read_file?: number
    zip_threshold_read_file?: number
    buffer_size_write_file?: number
    zip_threshold_write_file?: number
    buffer_size_edit_file?: number
    zip_threshold_edit_file?: number
    buffer_size_execute_command?: number
    zip_threshold_execute_command?: number
    buffer_size_list_files?: number
    zip_threshold_list_files?: number
    buffer_size_all_other_tools?: number
    zip_threshold_all_other_tools?: number
    auto_zip_read_file?: boolean
    auto_zip_write_file?: boolean
    auto_zip_edit_file?: boolean
    auto_zip_execute_command?: boolean
    auto_zip_list_files?: boolean
    auto_zip_all_other_tools?: boolean
    zip_disabled_read_file?: boolean
    zip_disabled_write_file?: boolean
    zip_disabled_edit_file?: boolean
    zip_disabled_execute_command?: boolean
    zip_disabled_list_files?: boolean
    zip_disabled_all_other_tools?: boolean
    
    // Custom tool settings
    custom_tool_settings?: Array<{
      tool_name: string
      buffer_size?: number
      zip_threshold?: number
      auto_zip?: boolean
      zip_disabled?: boolean
    }>
  }

  // Global permanent context compaction configuration
  global_auto_compact_settings?: GlobalAutoCompactSettings
  
  global_tool_grid_settings?: GlobalToolGridSettings
  voice_settings?: VoiceSettings
  goons_settings?: GoonsSettings
  created_at: string
  updated_at: string
}

export interface GoonRow extends GoonRecord {}

export interface SubagentRow {
  id: string
  user_id: string
  displayName: string
  description?: string

  // Canonical subagent contract (SA-062)
  subagentType?: StoredSubagentType

  // RENAMED: type → specialty (clearer purpose - Story 6.8a)
  specialty?: 'general' | 'n8n-specialist' | 'claude-code' | 'artifact'

  // DEPRECATED: Remove after migration complete (Story 6.8e cleanup)
  type?: 'ai' | 'claude_cli' | 'artifacts' | 'n8n_specialist'  // DEPRECATED - Use specialty instead

  workflowName?: string  // n8n workflow name for workflow-backed subagents
  webhook_url?: string  // Production webhook URL for n8n workflow subagents
  webhookUrl?: string  // Backward compatibility - same as webhook_url
  system_prompt?: string
  model?: string
  avatar?: string | null  // URL to avatar image
  avatar_icon_ref?: IconRef | null  // Icon-picker alternative to uploaded avatar
  avatar_icon_fit?: AvatarIconFit | null  // Avatar-only display fit for icon-picker avatars
  defaultMCPGateways?: string[]
  defaultMCPToolSelections?: string[]
  defaultTools?: string[] | null
  dcmDisplaySettings?: AgentDcmDisplaySettings
  // System prompt toggles
  include_global_prompt?: boolean  // Default: false (different from agents)
  include_batshit_subagent?: boolean  // Default: false - legacy toggle from the retired custom-node era
  include_claude_cli?: boolean    // Default: false - legacy toggle from the retired custom-node era
  // AI Provider settings
  primary_model_provider?: string
  primary_model_name?: string
  /** Optional per-call timeout override. Blank uses the type default. */
  timeout_seconds?: number
  primary_model_temperature?: number
  primary_model_max_tokens?: number
  primary_model_top_p?: number
  primary_model_top_k?: number
  primary_model_frequency_penalty?: number
  primary_model_presence_penalty?: number
  primary_model_reasoning_effort?: string
  primary_model_repetition_penalty?: number
  seed?: number
  stop_sequences?: string[]
  provider_specific_settings?: Record<string, any>
  codex_settings?: CodexAgentSettings | null
  claude_settings?: ClaudeAgentSettings | null
  credential_source?: string
  created_at: string
  updated_at: string
}

export interface AgentSubagentRow {
  id: string
  agent_id: string
  subagent_id: string
  position: number
  created_at: string
}

// Slash command types for reusable prompt expansions
export interface SlashCommandRow {
  id: string
  user_id: string
  name: string
  displayName?: string  // Optional friendly name
  description?: string

  // Command behavior
  type: 'prompt' | 'skill'  // Launch scope command types
  prompt_template?: string  // Template with {{variable}} placeholders
  instructions?: string  // Additional instructions for the AI

  // Parameters schema (for validation and UI generation)
  parameters?: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'array' | 'object'
    description?: string
    required?: boolean
    default?: any
    options?: any[]  // For enum-like parameters
  }>

  // Skill command metadata
  skill_id?: string
  skill_source?: 'system' | 'custom' | 'github' | 'git' | 'local' | 'url'
  skill_source_ref?: string
  skill_summary?: string
  skill_dependencies?: SkillDependencyRequirement[]
  skill_license?: string
  skill_compatibility?: string
  skill_metadata?: Record<string, string>
  skill_allowed_tools?: string[]
  skill_standards_status?: SkillStandardsStatus
  skill_standards_issues?: string[]
  skill_bundle_manifest?: SkillBundleManifest
  skill_bundle_files?: SkillBundleFile[]
  trust_level?: 'trusted' | 'untrusted'
  has_scripts?: boolean
  has_references?: boolean
  has_assets?: boolean

  // Invocation settings
  invocation_pattern?: string  // e.g., "/command-name" or custom pattern
  can_be_attached_to_agents?: boolean  // Reserved for future use
  can_be_invoked_in_chat?: boolean  // Whether users can invoke directly
  enabled_for_all_agents?: boolean  // Global attachment toggle; bypasses per-agent list
  enabled_agent_ids?: string[]  // Per-agent enablement list for DCM capability indexing

  // Metadata
  category?: string  // e.g., 'coding', 'writing', 'analysis', 'creativity'
  tags?: string[]
  icon_ref?: IconRef | null
  icon?: string  // Legacy string/emoji icon. New writes use icon_ref.

  // Usage tracking
  usage_count?: number
  last_used_at?: string

  // Settings
  is_active?: boolean  // Whether the command is active
  is_system?: boolean  // System commands (built-in, cannot be deleted)

  created_at: string
  updated_at: string
}

export interface SkillDependencyRequirement {
  id: string
  label?: string
  required?: boolean
}

export type SkillStandardsStatus = 'full' | 'degraded'
export type SkillBundleFileKind = 'script' | 'reference' | 'asset'
export type SkillBundleEncoding = 'utf8' | 'base64'

export interface SkillBundleFile {
  path: string
  kind: SkillBundleFileKind
  encoding: SkillBundleEncoding
  content: string
  sha256: string
  size: number
}

export interface SkillBundleManifest {
  version: 1
  checksum: string
  file_count: number
  script_count: number
  reference_count: number
  asset_count: number
  generated_at: string
}

export interface SkillRow {
  id: string
  user_id: string
  name: string
  displayName?: string
  description?: string
  skill_markdown: string
  source?: 'system' | 'custom' | 'github' | 'git' | 'local' | 'url'
  source_ref?: string
  dependencies?: SkillDependencyRequirement[]
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowed_tools?: string[]
  standards_status?: SkillStandardsStatus
  standards_issues?: string[]
  trust_level?: 'trusted' | 'untrusted'
  has_scripts?: boolean
  has_references?: boolean
  has_assets?: boolean
  bundle_manifest?: SkillBundleManifest
  bundle_files?: SkillBundleFile[]
  cache_path?: string
  is_system?: boolean
  is_active?: boolean
  created_at: string
  updated_at: string
}

export interface SkillSourceRow {
  id: string
  user_id: string
  label: string
  root_path: string
  scope: 'global' | 'project'
  trust_level?: 'trusted' | 'untrusted'
  enabled?: boolean
  enabled_for_all_agents?: boolean
  enabled_agent_ids?: string[]
  project_path?: string
  last_scanned_at?: string
  last_scan_status?: 'success' | 'error'
  last_scan_error?: string
  discovered_skill_ids?: string[]
  discovered_command_ids?: string[]
  created_at: string
  updated_at: string
}

// Clip types for user uploads (per-user, reusable across chats)
export interface ClipRow {
  id: string
  user_id: string
  filename: string
  fileType?: string  // 'image', 'pdf', 'document', 'text'
  mimeType?: string
  content?: string    // Plain UTF-8 for text-like files (no base64)
  
  // Storage URLs
  externalUrl?: string | null  // Retired for user uploads; kept nullable for older/system records
  displayUrl?: string   // URL for frontend display
  localUrl?: string     // Local storage URL (http://localhost:5600/...)
  tunnelPath?: string   // Stored upload path used to resolve the live tunnel URL at send time
  
  // Token costs
  externalTokens?: number  // Token cost when using external URL
  localTokens?: number     // Token cost when using base64/local
  
  // Storage metadata
  storageMode: 'local'
  localBase64?: string     // Legacy/system text clip payloads only; user image clips derive base64 at send time
  fileSize?: number        // Original file size in bytes
  
  // Settings at upload time
  uploadSettings?: {
    destination?: string   // 'local' for user clip uploads
    keepLocalCopy?: boolean
    compressionQuality?: number
    maxImageSize?: string
    forceJpeg?: boolean
  }
  
  // Usage tracking
  usedInSessions?: string[]  // Track which sessions use this clip
  lastUsedAt?: string
  
  // Metadata
  thumbnailUrl?: string      // For image previews
  description?: string       // User-provided description
  tags?: string[]           // For organization
  
  created_at: string
  updated_at?: string
}

// Session clips - tracks which clips are attached to a session
export interface SessionClipRow {
  id: string
  session_id: string
  clip_id: string
  is_clipped: boolean  // Currently attached to active message
  clipped_at?: string
  unclipped_at?: string
  message_id?: string  // Which message it's attached to
  created_at: string
}

// MCP Tool Selection types (SA-009: Simplified to flat list)
// Tool is enabled if it's in the list, disabled if not
export type MCPToolSelections = string[]

// SA-039: DCM display settings (global + agent)
export type DcmGroupDisplayMode =
  | 'group+tools+hints'
  | 'group+tools+names'
  | 'group-only'
  | 'hidden'
export type DcmToolDisplayMode = 'inherit' | 'name+hint' | 'name-only' | 'hidden'
export type AgentDcmGroupDisplayMode = 'use-global' | DcmGroupDisplayMode
export type GatewayDcmGroupDisplayMode = DcmGroupDisplayMode
export type AgentDcmGroupDisplayPreference = Exclude<AgentDcmGroupDisplayMode, 'hidden'>
export type AgentDcmToolDisplayPreference = Exclude<DcmToolDisplayMode, 'hidden'>

export interface GatewayDcmDisplaySettings {
  version: 1
  groups: Record<string, GatewayDcmGroupDisplayMode>
  tools: Record<string, DcmToolDisplayMode>
}

export interface GlobalCliToolGridSettings {
  discoverableToolIds?: string[]
  dcmDisplayDefaults?: GatewayDcmDisplaySettings
}

export interface GlobalBrokerFamilyToolGridSettings {
  dcmDisplayDefaults?: GatewayDcmDisplaySettings
}

export interface GlobalToolGridSettings {
  cli?: GlobalCliToolGridSettings
  fabric?: GlobalBrokerFamilyToolGridSettings
  artifact?: GlobalBrokerFamilyToolGridSettings
}

export interface AgentDcmDisplaySettings {
  version: 1
  groups: Record<string, AgentDcmGroupDisplayMode>
  tools: Record<string, DcmToolDisplayMode>
  groupDisplayPreferences?: Record<string, AgentDcmGroupDisplayPreference>
  toolDisplayPreferences?: Record<string, AgentDcmToolDisplayPreference>
}

// MCP Gateway types for unified gateway management (Story 5.22)
// MCP Tool Grouping (Story 5.23 - Enhanced)
// For n8n MCP Trigger gateways that combine multiple MCPs
// Direct tool-to-group assignment (replaces prefix-based rules)
export interface MCPToolGrouping {
  mcpName: string    // MCP name for this group (e.g., "n8n Documentation MCP")
  toolIds: string[]  // Exact tool IDs in this group (e.g., ["n8n_create-workflow", "read_file"])
  icon_ref?: IconRef | null
}

export type MCPGatewayType =
  | 'docker-catalog'
  | 'n8n-mcp-trigger'
  | 'n8n-instance-mcp'
  | 'custom'
  | 'stdio'
  | 'n8n-mcp-client'

export type MCPGatewayCwdPolicy = 'none' | 'project' | 'fixed'
export type MCPGatewayValidationStatus = 'never' | 'passed' | 'failed'

export interface MCPGatewayEnvRef {
  envVar: string
  savedKeyRef: string
}

export interface MCPGatewayStdioConfig {
  command: string
  args?: string[]
  cwdPolicy?: MCPGatewayCwdPolicy
  cwdValue?: string
  envRefs?: MCPGatewayEnvRef[]
  startupTimeoutMs?: number
  toolCallTimeoutMs?: number
  lastTestStatus?: MCPGatewayValidationStatus
  lastTestAt?: string
  lastError?: string | null
  toolCount?: number
  serverLabel?: string
}

export interface MCPGateway {
  id: string
  name: string
  slug?: string
  type: MCPGatewayType
  url?: string
  enabled: boolean
  autoStart?: boolean  // For Docker gateway
  discoveredTools?: string[]  // Cached tool list (refreshable)
  lastDiscovery?: number  // Timestamp of last discovery
  toolGroupings?: MCPToolGrouping[]  // Story 5.23: Direct tool-to-group assignments
  authKeyName?: string  // API key slot name for Bearer auth (e.g., 'huggingface')
  icon_ref?: IconRef | null
  stdioConfig?: MCPGatewayStdioConfig
  // SA-039: Gateway-level defaults for Dynamic MCP DCM display
  dcmDisplayDefaults?: GatewayDcmDisplaySettings
  metadata?: Record<string, any>  // Type-specific config
  created_at: string
  updated_at?: string
}

// Storage structure for gateway registry
export interface MCPGatewayRegistry {
  gateways: MCPGateway[]
}

export type CliToolStatus = 'active' | 'disabled' | 'archived'
export type CliToolOrigin = 'manual' | 'imported' | 'generated'
export type CliToolRiskLevel = 'safe' | 'confirm' | 'restricted'
export type CliToolOutputMode = 'text' | 'json' | 'mixed'
export type CliToolParseMode = 'text' | 'json' | 'json_in_text'
export type CliToolCwdPolicy = 'none' | 'project' | 'fixed'
export type CliToolValidationStatus = 'never' | 'passed' | 'failed'

export interface CliToolEnvRef {
  envVar: string
  savedKeyRef: string
}

export type CliToolInputFieldType = 'string' | 'number' | 'boolean' | 'array'
export type CliToolInputFieldFormat = 'plain' | 'path'

export interface CliToolInputField {
  type: CliToolInputFieldType
  description?: string
  required?: boolean
  enum?: Array<string | number | boolean>
  items?: {
    type: Exclude<CliToolInputFieldType, 'array'>
  }
  format?: CliToolInputFieldFormat
}

export interface CliToolInputSchema {
  type: 'object'
  properties: Record<string, CliToolInputField>
  required?: string[]
}

export type CliToolArgTemplateEntry =
  | {
      kind: 'literal'
      value: string
    }
  | {
      kind: 'input'
      field: string
      required?: boolean
    }
  | {
      kind: 'option'
      flag: string
      field: string
      required?: boolean
    }
  | {
      kind: 'flag'
      flag: string
      field: string
    }
  | {
      kind: 'repeat'
      field: string
      flag?: string
      required?: boolean
    }

export interface CliToolRecord {
  toolId: string
  title: string
  description: string
  tags: string[]
  origin: CliToolOrigin
  status: CliToolStatus
  executable: string
  argsTemplate: CliToolArgTemplateEntry[]
  inputSchema: CliToolInputSchema
  outputMode: CliToolOutputMode
  parseMode: CliToolParseMode
  cwdPolicy: CliToolCwdPolicy
  cwdValue?: string
  timeoutMs: number
  envRefs?: CliToolEnvRef[]
  riskLevel: CliToolRiskLevel
  allowNetwork: boolean
  allowWrite: boolean
  allowedPaths?: string[]
  helpCommand?: string[]
  validationInput?: Record<string, any>
  examples?: string[]
  iconRef?: IconRef | null
  iconHint?: string  // Legacy string/emoji hint. New writes use iconRef.
  createdAt: string
  updatedAt: string
  lastValidatedAt?: string
  lastValidationStatus?: CliToolValidationStatus
  lastValidationError?: string | null
  lastValidationSummary?: string | null
}

export interface CliToolRegistryStore {
  version: number
  records: CliToolRecord[]
}

// Convenience type for chat messages (matches our store)
export type ChatMessage = ChatMemoryRow
