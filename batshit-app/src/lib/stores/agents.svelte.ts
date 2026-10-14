// Agents store using Svelte 5 runes
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { CodexAgentSettings } from '$lib/types/codex'
import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { AgentVoiceProfile } from '$lib/types/voice'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { StoredPrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { AgentAutoCompactSettings } from '$lib/utils/contextCompaction'
import { applyAgentProviderSettingsUpdate } from '$lib/utils/agentProviderSettings'
import {
  AGENT_FIELD_BY_FIELD_BLOCKS,
  applyAgentBlockUpdate,
  type AgentBlockSaveByField,
  type AgentFieldByFieldBlock
} from '$lib/utils/agentBlockFieldSettings'
import { AGENT_MEMORY_STORED_FIELDS } from '$lib/utils/agentSettingsSavePatch'
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
  zip_agent_control_experiment?: boolean | null  // The parked zip control permission (BL-1484); no UI
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
  // BL-515: null clears a value (the agent PUT stores null as absent).
  primary_model_temperature?: number | null
  primary_model_max_tokens?: number | null
  primary_model_top_p?: number | null
  primary_model_top_k?: number | null
  primary_model_frequency_penalty?: number | null
  primary_model_presence_penalty?: number | null
  primary_model_capabilities?: ModelCapabilities | null
  primary_model_connection?: ModelConnectionInfo | null
  primary_model_seed?: number | null
  primary_model_stop_sequences?: string[] | null
  primary_model_reasoning_effort?: string | null
  custom_model_settings?: string  // Advanced key=value pairs for power users
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

/**
 * What a save of agent fields sends (`updateAgentSettings`). The Codex and Claude settings and the
 * Tool Grid display settings are written field by field (BL-848, BL-855), so a save of them names
 * only the keys (or map entries) it changes, a removed one as `null`: `diffAgentBlock` builds it.
 */
export type AgentSettingsUpdate = Omit<Partial<Agent>, AgentFieldByFieldBlock> & {
  [Field in AgentFieldByFieldBlock]?: AgentBlockSaveByField[Field] | null
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
export async function updateAgentSettings(id: string, updates: AgentSettingsUpdate) {
  const previousAgent = agents.find((agent) => agent.id === id) ?? null
  // BL-514: the copy takes the save the way the server stores it: a block's model keys replace
  // the old ones and the agent's own keys stay unless the save names them. BL-848, BL-855: the
  // Codex and Claude settings and the Tool Grid display settings take the keys (and map entries)
  // the save names and keep the rest, never a shallow replace of the block.
  const localUpdates: Record<string, unknown> = { ...updates }
  if ('provider_specific_settings' in updates) {
    localUpdates.provider_specific_settings = applyAgentProviderSettingsUpdate(
      previousAgent?.provider_specific_settings,
      updates.provider_specific_settings
    )
  }
  for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) {
    if (field in updates) localUpdates[field] = applyAgentBlockUpdate(field, previousAgent?.[field], updates[field])
  }
  updateAgent(id, localUpdates as Partial<Agent>)
  
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

export type AgentSettingsFamily = 'memory' | 'identity'

/** The record fields each family of an agent's own Settings save can change (App Actions). */
const AGENT_SETTINGS_FAMILY_FIELDS: Record<AgentSettingsFamily, readonly string[]> = {
  identity: ['displayName'],
  memory: AGENT_MEMORY_STORED_FIELDS
}

/**
 * One counter per agent AND family: a later identity read never drops an earlier memory read (that
 * memory change would then never reach this copy), and only a newer read of the same family drops
 * an older one, whatever order their answers come in.
 */
const familyReadGenerations = new Map<string, number>()

/**
 * SA-122 A-1y (LS-067/LS-068): the agent changed its own Settings (`agent_settings_changed` on the
 * user channel, `userChannel.ts`). Reads the agent again and takes only that family's fields, so the
 * labels that read this store (the agent picker, the chat bar, the chat page) show the saved value.
 * A field the record no longer holds is cleared in the copy too. An agent this tab has not loaded
 * is not read. A failed read changes nothing and says so in the console; the page reads the
 * selected agent again before each send.
 */
export async function refreshAgentFieldsFromServer(agentId: string, family: AgentSettingsFamily): Promise<void> {
  if (!agents.some((agent) => agent.id === agentId)) return
  const key = `${agentId}\n${family}`
  const generation = (familyReadGenerations.get(key) ?? 0) + 1
  familyReadGenerations.set(key, generation)
  let record: Record<string, unknown>
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    record = await response.json()
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== agentId) {
      throw new Error('the answer is not this agent')
    }
  } catch (error) {
    console.warn(`[agents] Could not read agent ${agentId} again after its ${family} settings changed:`, error)
    return
  }
  if (familyReadGenerations.get(key) !== generation) return
  const fields = AGENT_SETTINGS_FAMILY_FIELDS[family]
  updateAgent(agentId, Object.fromEntries(fields.map((field) => [field, record[field]])) as Partial<Agent>)
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
