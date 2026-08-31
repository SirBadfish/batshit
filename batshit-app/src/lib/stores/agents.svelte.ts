// Agents store using Svelte 5 runes
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { CodexAgentSettings } from '$lib/types/codex'
import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { AgentVoiceProfile } from '$lib/types/voice'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { StoredPrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { AgentAutoCompactSettings } from '$lib/utils/contextCompaction'
export interface Agent {
  id: string
  user_id: string
  displayName: string
  description?: string
  webhook_url?: string
  agent_url?: string
  default_project_id?: string | null
  avatar?: string | null  // URL to avatar image
  avatar_url?: string | null  // Mapped from avatar for frontend use
  avatar_icon_ref?: IconRef | null
  avatar_icon_fit?: AvatarIconFit | null
  agentType?: StoredPrimaryAgentType
  show_reasoning?: boolean  // Display model reasoning summaries in chat
  preserve_reasoning?: boolean  // Include saved reasoning in this agent's later compiled model history
  tool_approval_mode?: 'off' | 'all'
  auto_compact_settings?: AgentAutoCompactSettings | null
  voice_profile?: AgentVoiceProfile
  goon_id?: string | null
  created_at: string
  updated_at: string
  // Zipping settings
  buffer_size?: number  // Number of previous assistant responses before zipping
  buffer_size_image?: number  // Buffer for image blocks (default 0 in SA-019)
  auto_zip_error?: boolean
  auto_zip_image?: boolean
  auto_zip_subagent?: boolean
  zip_control_mode?: 'user' | 'agent' | null  // DEPRECATED (legacy agent-managed toggle)
  zip_agent_control_enabled?: boolean | null
  zip_ai_view_mode?: 'inline' | 'appended' | null
  zip_tool_notes_enabled?: boolean | null
  zip_threshold_error?: number  // Tokens threshold for errors (default 0)
  zip_threshold_image?: number  // Tokens threshold for image blocks (default 0 in SA-019)
  zip_threshold_subagent?: number  // Tokens threshold for subagent conversations (default 0)
  // Per-type buffer settings
  buffer_size_error?: number  // Buffer for errors (default: uses buffer_size)
  buffer_size_subagent?: number  // Buffer for subagent conversations (default: uses buffer_size)
  
  // Granular tool-specific settings
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
  custom_tool_settings?: Array<{
    tool_name: string
    buffer_size?: number
    zip_threshold?: number
    auto_zip?: boolean
  }>
  overridden_settings?: string[]
  
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
  custom_model_settings?: string  // Advanced key=value pairs for power users
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
  model_routing_rules?: any  // JSONB
  ai_permissions?: any  // JSONB
  provider_specific_settings?: Record<string, any>  // JSONB
  credential_source?: string  // For Anthropic: 'n8n' or 'claude-cli'
  assigned_subagent_ids?: string[]  // Track which subagents are assigned to this agent
  // System prompt settings
  name?: string  // Internal name (used for safe keys)
  system_prompt?: string  // Custom system prompt
  include_global_prompt?: boolean  // Include global custom prompt
  // Tool settings
  defaultTools?: string[] | null  // Array of tool IDs that are enabled by default for this agent
  // MCP Gateway settings (SA-009: Flat list model)
  defaultMCPGateways?: string[]  // Gateway IDs to load automatically in Mode 3
  defaultMCPToolSelections?: string[]  // Flat list of enabled tool names
  dcmDisplaySettings?: AgentDcmDisplaySettings
  // Subagent assignment (Story 6.8 → Architecture Simplification)
  assignedSubagents?: string[]  // Array of subagent IDs assigned to this agent
  codex_settings?: CodexAgentSettings | null
  claude_settings?: ClaudeAgentSettings | null
}

let agents = $state<Agent[]>([])
let currentAgentId = $state<string | null>(null)

export function getAgents() {
  return agents
}

export function getCurrentAgentId() {
  return currentAgentId
}

export function setAgents(newAgents: Agent[]) {
  agents = newAgents
}

export function setCurrentAgentId(id: string | null) {
  currentAgentId = id
  // Persist to localStorage
  if (id) {
    localStorage.setItem('lastSelectedAgent', id)
  } else {
    localStorage.removeItem('lastSelectedAgent')
  }
}

export function addAgent(agent: Agent) {
  agents = [...agents, agent]
}

export function updateAgent(id: string, updates: Partial<Agent>) {
  agents = agents.map(a => 
    a.id === id ? { ...a, ...updates } : a
  )
}

export function deleteAgent(id: string) {
  agents = agents.filter(a => a.id !== id)
  if (currentAgentId === id) {
    // If we're deleting the current agent, try to select another one
    if (agents.length > 0) {
      // Select the first remaining agent
      setCurrentAgentId(agents[0].id)
    } else {
      // No agents left, clear the selection
      setCurrentAgentId(null)
    }
  }
}

// Function to get current agent
export function getCurrentAgent() {
  return agents.find(a => a.id === currentAgentId) || null
}

export function setCurrentAgent(id: string) {
  setCurrentAgentId(id)
}

// Function to get all agents (no is_active field in database)
export function getAllAgents() {
  return agents
}

// Function to get agent by ID
export function getAgentById(id: string | null | undefined) {
  if (!id) return null
  return agents.find(a => a.id === id) || null
}

// Function to update agent settings (alias for updateAgent)
export async function updateAgentSettings(id: string, updates: Partial<Agent>) {
  const previousAgent = agents.find((agent) => agent.id === id) ?? null
  updateAgent(id, updates)
  
  // Also update in database
  try {
    const response = await fetch(`/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    
    if (!response.ok) {
      throw new Error('Failed to update agent in database')
    }
  } catch (error) {
    if (previousAgent) {
      updateAgent(id, previousAgent)
    }
    console.error('Error updating agent settings:', error)
    throw error
  }
}

// Function to load agents from database
export async function loadAgents(userId: string) {
  try {
    // Import DatabaseService dynamically to avoid circular dependencies
    const { DatabaseService } = await import('$lib/services/databaseRedis.client')
    const db = new DatabaseService()
    
    const data = await db.getAgents(userId)
    
    // Map database snake_case to frontend camelCase
    agents = (data || []).map(a => ({
      ...a,
      displayName: a.displayName || '', // Map displayName
      avatar_url: a.avatar || a.avatar_url || undefined
    }))
    
    return agents
  } catch (error) {
    console.error('Failed to load agents:', error)
    throw error
  }
}
