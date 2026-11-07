import { MCP_SETTINGS_FIELDS, MCP_SETTINGS_REVISION_HEADER, mcpSettingsLeaves, readMcpSettingsRevisions, withExpectedMcpSettings, type ExpectedMcpSettings } from '$lib/utils/agentSettingsSectionSaves'
// Agents store using Svelte 5 runes
import type { ModelCapabilities, ModelConnectionInfo } from '$lib/types/savedModels'
import type { ClaudeAgentSettings } from '$lib/types/claude'
import type { AgentReasoningOverrides } from '$lib/types/reasoningControls'
import type { AgentVoiceProfile } from '$lib/types/voice'
import type { AgentDcmDisplaySettings } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { StoredPrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { AgentAutoCompactSettings } from '$lib/utils/contextCompaction'
import { applyAgentProviderSettingsUpdate } from '$lib/utils/agentProviderSettings'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import {
  AGENT_FIELD_BY_FIELD_BLOCKS,
  applyAgentBlockUpdate,
  type AgentBlockSaveByField,
  type AgentFieldByFieldBlock
} from '$lib/utils/agentBlockFieldSettings'
import { AGENT_MEMORY_STORED_FIELDS } from '$lib/utils/agentSettingsSavePatch'
import { captureAgentReasoningReads, preserveNewerReasoningLeaves } from '$lib/utils/agentReasoningReadGuard'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { MODEL_SELECTION_FIELDS, isModelSelectionWrite, sameModelSelection, withModelSelection } from '$lib/appActions/settings/modelSelectionBaseline'
import { namesInstructions, type InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline'
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
  api_reasoning_retention?: import('$lib/utils/reasoningRetention').ApiReasoningRetentionMode | null
  whiteboard_budget_tokens?: number | null
  show_whiteboard?: boolean | null
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
  zip_ai_view_mode?: 'inline' | 'appended' | null
  zip_tool_notes_enabled?: boolean | null
  live_file_reads?: boolean | null  // SA-137: live file reads for this agent; null or absent inherits the global Tool Grid value
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
  model_reasoning_overrides?: AgentReasoningOverrides
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
  claude_settings?: ClaudeAgentSettings | null
}

/**
 * What a save of agent fields sends (`updateAgentSettings`). The Claude settings and the
 * Tool Grid display settings are written field by field (BL-848, BL-855), so a save of them names
 * only the keys (or map entries) it changes, a removed one as `null`: `diffAgentBlock` builds it.
 */
export type AgentSettingsUpdate = Omit<Partial<Agent>, AgentFieldByFieldBlock> & {
  [Field in AgentFieldByFieldBlock]?: AgentBlockSaveByField[Field] | null
} & { expectedMcpSettings?: ExpectedMcpSettings; expectedModelSelection?: string; expectedInstructions?: Partial<InstructionsRevisions>; expectedAutoCompact?: string }

type McpDetailCut = { record: Record<string, unknown>; revisions: ExpectedMcpSettings }
let mcpDetailCuts = $state<Record<string, McpDetailCut>>({})
const mcpWritesPending = new Map<string, number>(), mcpWriteGenerations = new Map<string, number>(), mcpRefreshRequested = new Set<string>()
export function getAgentMcpSettingsCut(id: string): McpDetailCut | undefined { return mcpDetailCuts[id] }
export function getAgentMcpSettingsReadState(id: string) { return { generation: mcpWriteGenerations.get(id) ?? 0, pending: (mcpWritesPending.get(id) ?? 0) > 0 } }
export async function loadAgentMcpSettingsDetail(id: string) { const before = mcpDetailCuts[id]; await refreshAgentFieldsFromServer(id, 'mcp-settings'); const after = mcpDetailCuts[id]; return after && after !== before ? after : undefined }
function mcpProjection(row: object) { return Object.fromEntries(MCP_SETTINGS_FIELDS.filter(field => Object.hasOwn(row, field)).map(field => [field, (row as Record<string, unknown>)[field]])) }
let agents = $state<Agent[]>([])
let currentAgentId = $state<string | null>(null)
const modelWriteGenerations = new Map<string, number>()
const modelWritesPending = new Map<string, number>()
const modelRefreshRequested = new Set<string>()
const instructionsWriteGenerations = new Map<string, number>()
const instructionsWritesPending = new Map<string, number>()
const instructionsRefreshRequested = new Set<string>()
const autoCompactWriteGenerations = new Map<string, number>()
const autoCompactWritesPending = new Map<string, number>()
const autoCompactRefreshRequested = new Set<string>()
const providerWriteGenerations = new Map<string, number>()
const providerWritesPending = new Map<string, number>()
/** Join a small native-choice surface to the existing provider read/write owner. */
export function getAgentProviderSettingsReadState(id: string) {
  return { generation: providerWriteGenerations.get(id) ?? 0, pending: (providerWritesPending.get(id) ?? 0) > 0, record: getAgentById(id) }
}
const providerReadsPending = new Set<string>()
const providerRefreshRequested = new Set<string>()
function drainProviderRefresh(id: string) {
  if (providerReadsPending.has(id) || (providerWritesPending.get(id) ?? 0) > 0 || !providerRefreshRequested.delete(id)) return
  void refreshAgentFieldsFromServer(id, 'provider-settings')
}
function drainAutoCompactRefresh(id: string) {
  if ((autoCompactWritesPending.get(id) ?? 0) > 0 || !autoCompactRefreshRequested.delete(id)) return
  void refreshAgentFieldsFromServer(id, 'auto-compact')
}
function drainInstructionsRefresh(id: string) {
  if ((instructionsWritesPending.get(id) ?? 0) > 0 || !instructionsRefreshRequested.delete(id)) return
  void refreshAgentFieldsFromServer(id, 'instructions')
}
function instructionsProjection(row: object): Record<string, unknown> {
  return Object.fromEntries(['system_prompt', 'include_global_prompt'].filter(field => Object.hasOwn(row, field)).map(field => [field, (row as Record<string, unknown>)[field]]))
}
function withInstructions<T extends object>(row: T, incoming: object): T {
  const result = { ...row } as Record<string, unknown>
  for (const field of ['system_prompt', 'include_global_prompt']) {
    if (Object.hasOwn(incoming, field)) result[field] = (incoming as Record<string, unknown>)[field]
    else delete result[field]
  }
  return result as T
}
function drainModelRefresh(id: string) {
  if ((modelWritesPending.get(id) ?? 0) > 0 || !modelRefreshRequested.delete(id)) return
  void refreshAgentFieldsFromServer(id, 'model-selection')
}

/** Read owners must not install a model source over a pending optimistic model save. */
export function getAgentModelSelectionReadState(id: string) {
  return { generation: modelWriteGenerations.get(id) ?? 0, pending: (modelWritesPending.get(id) ?? 0) > 0 }
}

export function getAgents() {
  return agents
}

export function getCurrentAgentId() {
  return currentAgentId
}

export function setAgents(newAgents: Agent[]) {
  for (const agent of newAgents) providerWriteGenerations.set(agent.id, (providerWriteGenerations.get(agent.id) ?? 0) + 1)
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
  providerWriteGenerations.set(agent.id, (providerWriteGenerations.get(agent.id) ?? 0) + 1)
  agents = [...agents, agent]
}

export function updateAgent(id: string, updates: Partial<Agent>) {
  // Raw mounted owners also accept their saved/detail copies through this function.
  // Even a same-value instruction save supersedes a read that started before it.
  if (namesInstructions(updates as Record<string, unknown>)) instructionsWriteGenerations.set(id, (instructionsWriteGenerations.get(id) ?? 0) + 1)
  if (Object.hasOwn(updates, 'auto_compact_settings')) autoCompactWriteGenerations.set(id, (autoCompactWriteGenerations.get(id) ?? 0) + 1)
  if (Object.hasOwn(updates, 'provider_specific_settings')) providerWriteGenerations.set(id, (providerWriteGenerations.get(id) ?? 0) + 1)
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
  const mcpWrite = mcpSettingsLeaves(updates).length > 0
  if (mcpWrite) withExpectedMcpSettings(updates, updates.expectedMcpSettings) // original caller cut, never GET at save
  let mcpKnownSaved = false
  const previousAgent = agents.find((agent) => agent.id === id) ?? null
  const modelWrite = isModelSelectionWrite('agent', updates as Record<string, unknown>)
  const instructionsWrite = namesInstructions(updates as Record<string, unknown>)
  const autoCompactWrite = Object.hasOwn(updates, 'auto_compact_settings')
  const providerWrite = updates.provider_specific_settings !== undefined
  let providerKnownSaved = false
  let autoCompactKnownSaved = false
  let instructionsKnownSaved = false
  let modelKnownSaved = false
  // BL-514: the copy takes the save the way the server stores it: a block's model keys replace
  // the old ones and the agent's own keys stay unless the save names them. BL-848, BL-855: the
  // Claude settings and the Tool Grid display settings take the keys (and map entries)
  // the save names and keep the rest, never a shallow replace of the block.
  const localUpdates: Record<string, unknown> = { ...updates }
  delete localUpdates.expectedMcpSettings
  delete localUpdates.expectedModelSelection
  delete localUpdates.expectedInstructions
  delete localUpdates.expectedAutoCompact
  if ('provider_specific_settings' in updates) {
    localUpdates.provider_specific_settings = applyAgentProviderSettingsUpdate(
      previousAgent?.provider_specific_settings,
      updates.provider_specific_settings
    )
  }
  for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) {
    if (field in updates) localUpdates[field] = applyAgentBlockUpdate(field, previousAgent?.[field], updates[field])
  }
  if (mcpWrite) { mcpWritesPending.set(id, (mcpWritesPending.get(id) ?? 0) + 1); mcpWriteGenerations.set(id, (mcpWriteGenerations.get(id) ?? 0) + 1) }
  if (modelWrite) {
    modelWriteGenerations.set(id, (modelWriteGenerations.get(id) ?? 0) + 1)
    modelWritesPending.set(id, (modelWritesPending.get(id) ?? 0) + 1)
  }
  if (instructionsWrite) {
    instructionsWriteGenerations.set(id, (instructionsWriteGenerations.get(id) ?? 0) + 1)
    instructionsWritesPending.set(id, (instructionsWritesPending.get(id) ?? 0) + 1)
  }
  if (autoCompactWrite) {
    autoCompactWriteGenerations.set(id, (autoCompactWriteGenerations.get(id) ?? 0) + 1)
    autoCompactWritesPending.set(id, (autoCompactWritesPending.get(id) ?? 0) + 1)
  }
  if (providerWrite) {
    providerWriteGenerations.set(id, (providerWriteGenerations.get(id) ?? 0) + 1)
    providerWritesPending.set(id, (providerWritesPending.get(id) ?? 0) + 1)
  }
  
  // Also update in database
  try {
    updateAgent(id, localUpdates as Partial<Agent>)
    const response = await fetch(`/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    
    if (!response.ok) {
      if (mcpWrite) {
        const payload = await response.clone().json().catch(() => null)
        mcpKnownSaved = payload?.mcpSettingsSaved === true
        if (response.status === 409 || mcpKnownSaved) mcpRefreshRequested.add(id)
        throw Object.assign(new Error(payload?.error || 'The Tool Settings save could not be confirmed.'), { status: response.status, code: payload?.code, mcpSettingsSaved: mcpKnownSaved, mcpSettings: payload?.mcpSettings })
      }
      if (autoCompactWrite) {
        const payload = await response.clone().json().catch(() => null)
        if (payload?.code === 'auto_compact_settings_changed') autoCompactRefreshRequested.add(id)
        throw Object.assign(new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to confirm the Auto Compact save.'), { code: payload?.code, status: response.status })
      }
      if (instructionsWrite && response.status === 409) instructionsRefreshRequested.add(id)
      if (updates.expectedInstructions) {
        const payload = await response.clone().json().catch(() => null)
        throw Object.assign(new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to confirm the instructions save.'), { code: payload?.code, status: response.status })
      }
      if (modelWrite && response.status === 409) modelRefreshRequested.add(id)
      if (updates.expectedModelSelection) {
        const payload = await response.clone().json().catch(() => null)
        throw Object.assign(new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to confirm the model selection.'),
          { code: payload?.code, status: response.status })
      }
      throw new Error('Failed to update agent in database')
    }
    mcpKnownSaved = true
    providerKnownSaved = true
    if (mcpWrite) {
      const payload = await response.clone().json()
      const revisions = readMcpSettingsRevisions(JSON.stringify(payload?.mcpSettings?.revisions))
      if (!revisions || mcpSettingsLeaves(updates).some(field => !revisions[field])) throw new Error('The acknowledged Tool Settings base is missing. Check saved values; do not repeat this save.')
      return payload
    }
    modelKnownSaved = true
    instructionsKnownSaved = true
    autoCompactKnownSaved = true
  } catch (error) {
    if (mcpWrite && mcpKnownSaved) {
      // Actual known ACK survives unrelated post-save/profile failure; no optimistic rollback.
    } else if (previousAgent && (instructionsWrite || autoCompactWrite || mcpWrite)) {
      const current = getAgentById(id)
      if (current?.user_id === previousAgent.user_id) {
        // A mixed request was refused as a whole. Roll back only leaves still owned by
        // this optimistic request, preserving a later local edit to any other leaf.
        const rollback = { ...current } as Record<string, unknown>
        for (const field of Object.keys(localUpdates)) {
          if (!sameJsonValue(rollback[field], localUpdates[field])) continue
          if (Object.hasOwn(previousAgent, field)) rollback[field] = (previousAgent as unknown as Record<string, unknown>)[field]
          else delete rollback[field]
        }
        agents = agents.map(row => row.id === id ? rollback as unknown as Agent : row)
      }
    } else if (previousAgent && updates.expectedModelSelection) {
      const current = getAgentById(id)
      if (current && sameModelSelection('agent', current as unknown as Record<string, unknown>, { ...previousAgent, ...localUpdates } as unknown as Record<string, unknown>)) {
        updateAgent(id, withModelSelection('agent', current as unknown as Record<string, unknown>, previousAgent as unknown as Record<string, unknown>) as Partial<Agent>)
      }
    } else if (previousAgent) {
      updateAgent(id, previousAgent)
    }
    console.error('Error updating agent settings:', error)
    throw error
  } finally {
    if (providerWrite) {
      providerWritesPending.set(id, Math.max(0, (providerWritesPending.get(id) ?? 1) - 1))
      providerWriteGenerations.set(id, (providerWriteGenerations.get(id) ?? 0) + 1)
      if (providerKnownSaved) providerRefreshRequested.add(id)
      drainProviderRefresh(id)
    }
    if (mcpWrite) {
      mcpWritesPending.set(id, Math.max(0, (mcpWritesPending.get(id) ?? 1) - 1)); mcpWriteGenerations.set(id, (mcpWriteGenerations.get(id) ?? 0) + 1)
      if (mcpKnownSaved) mcpRefreshRequested.add(id)
      if (!(mcpWritesPending.get(id) ?? 0) && mcpRefreshRequested.delete(id)) void refreshAgentFieldsFromServer(id, 'mcp-settings')
    }
    if (autoCompactWrite) {
      autoCompactWritesPending.set(id, Math.max(0, (autoCompactWritesPending.get(id) ?? 1) - 1))
      autoCompactWriteGenerations.set(id, (autoCompactWriteGenerations.get(id) ?? 0) + 1)
      if (autoCompactKnownSaved) autoCompactRefreshRequested.add(id)
      drainAutoCompactRefresh(id)
    }
    if (instructionsWrite) {
      instructionsWritesPending.set(id, Math.max(0, (instructionsWritesPending.get(id) ?? 1) - 1))
      instructionsWriteGenerations.set(id, (instructionsWriteGenerations.get(id) ?? 0) + 1)
      if (instructionsKnownSaved) instructionsRefreshRequested.add(id)
      drainInstructionsRefresh(id)
    }
    if (modelWrite) {
      modelWritesPending.set(id, Math.max(0, (modelWritesPending.get(id) ?? 1) - 1))
      modelWriteGenerations.set(id, (modelWriteGenerations.get(id) ?? 0) + 1)
      if (modelKnownSaved) modelRefreshRequested.add(id)
      drainModelRefresh(id)
    }
  }
}

export type AgentSettingsFamily = 'mcp-settings' | 'provider-settings' | 'memory' | 'identity' | 'retention' | 'model-selection' | 'instructions' | 'auto-compact' | 'voice-selection'

/** The record fields each family of an agent's own Settings save can change (App Actions). */
const AGENT_SETTINGS_FAMILY_FIELDS: Record<AgentSettingsFamily, readonly string[]> = {
  identity: ['displayName'],
  'provider-settings': ['provider_specific_settings'],
  retention: ['api_reasoning_retention', 'whiteboard_budget_tokens', 'show_whiteboard', 'show_reasoning', 'preserve_reasoning'],
  memory: AGENT_MEMORY_STORED_FIELDS,
  'mcp-settings': MCP_SETTINGS_FIELDS,
  'model-selection': MODEL_SELECTION_FIELDS,
  instructions: ['system_prompt', 'include_global_prompt'],
  'auto-compact': ['auto_compact_settings'],
  'voice-selection': ['voice_profile']
}

/**
 * One counter per agent AND family: a later identity read never drops an earlier memory read (that
 * memory change would then never reach this copy), and only a newer read of the same family drops
 * an older one, whatever order their answers come in.
 */
const familyReadGenerations = new Map<string, number>()

function isProviderToolSetting(key: string): boolean {
  // These two legacy mirrors belong to withModelSelection, even though they are
  // agent-runtime keys for provider serialization purposes (`codex_model` survives only as a
  // stored leftover of the removed Codex CLI, SA-139 R1).
  return isAgentRuntimeSettingKey(key) && key !== 'codex_model' && key !== 'claude_model'
}
function providerRuntimeProjection(settings: Agent['provider_specific_settings']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([key]) => isProviderToolSetting(key)))
}

/** BL-1876: this family owns runtime/tool keys, while model parameters keep their model-selection owner. */
async function refreshProviderSettingsFromServer(agentId: string): Promise<void> {
  if (providerReadsPending.has(agentId) || (providerWritesPending.get(agentId) ?? 0) > 0) {
    providerRefreshRequested.add(agentId)
    return
  }
  const before = getAgentById(agentId)
  if (!before) return
  const generation = providerWriteGenerations.get(agentId) ?? 0
  const beforeSettings = JSON.stringify(providerRuntimeProjection(before.provider_specific_settings))
  providerRefreshRequested.delete(agentId)
  providerReadsPending.add(agentId)
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const record = await response.json()
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== agentId ||
      record.user_id !== before.user_id || record.agentType !== before.agentType || record.created_at !== before.created_at ||
      record.provider_specific_settings != null && (typeof record.provider_specific_settings !== 'object' || Array.isArray(record.provider_specific_settings))) {
      throw new Error('The saved provider settings are unreadable or belong to a different agent.')
    }
    const current = getAgentById(agentId)
    if (!current || current.user_id !== before.user_id || current.agentType !== before.agentType || current.created_at !== before.created_at) return
    if (generation !== (providerWriteGenerations.get(agentId) ?? 0) || (providerWritesPending.get(agentId) ?? 0) > 0 ||
      providerRefreshRequested.has(agentId) || JSON.stringify(providerRuntimeProjection(current.provider_specific_settings)) !== beforeSettings) {
      // A model/source read may have installed only its part of this block while this
      // event was in flight. Retain one fresh read so its tool change is not lost.
      providerRefreshRequested.add(agentId)
      return
    }
    agents = agents.map(row => {
      if (row.id !== agentId) return row
      const next = { ...row }
      const settings = { ...row.provider_specific_settings }
      for (const key of Object.keys(settings)) if (isProviderToolSetting(key)) delete settings[key]
      Object.assign(settings, providerRuntimeProjection(record.provider_specific_settings))
      if (Object.keys(settings).length) next.provider_specific_settings = settings
      else delete next.provider_specific_settings
      return next
    })
  } catch (error) {
    console.warn(`[agents] Could not read agent ${agentId} again after its provider-settings changed:`, error)
  } finally {
    providerReadsPending.delete(agentId)
    drainProviderRefresh(agentId)
  }
}

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
  if (family === 'provider-settings') return refreshProviderSettingsFromServer(agentId)
  if (family === 'mcp-settings' && (mcpWritesPending.get(agentId) ?? 0) > 0) { mcpRefreshRequested.add(agentId); return }
  const mcpGeneration = mcpWriteGenerations.get(agentId) ?? 0, mcpBefore = getAgentById(agentId)
  let mcpRevisions: ExpectedMcpSettings | undefined
  if (family === 'model-selection' && (modelWritesPending.get(agentId) ?? 0) > 0) { modelRefreshRequested.add(agentId); return }
  if (family === 'instructions' && (instructionsWritesPending.get(agentId) ?? 0) > 0) { instructionsRefreshRequested.add(agentId); return }
  if (family === 'auto-compact' && (autoCompactWritesPending.get(agentId) ?? 0) > 0) { autoCompactRefreshRequested.add(agentId); return }
  const autoCompactGeneration = autoCompactWriteGenerations.get(agentId) ?? 0
  const autoCompactBefore = family === 'auto-compact' ? getAgentById(agentId) : null
  const instructionsGeneration = instructionsWriteGenerations.get(agentId) ?? 0
  const instructionsBefore = family === 'instructions' ? getAgentById(agentId) : null
  const modelReadGeneration = modelWriteGenerations.get(agentId) ?? 0
  const fields = AGENT_SETTINGS_FAMILY_FIELDS[family]
  const modelBefore = family === 'model-selection' ? getAgentById(agentId) : null
  const key = `${agentId}\n${family}`
  const generation = (familyReadGenerations.get(key) ?? 0) + 1
  familyReadGenerations.set(key, generation)
  let record: Record<string, unknown>
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    mcpRevisions = readMcpSettingsRevisions(response.headers.get(MCP_SETTINGS_REVISION_HEADER))
    record = await response.json()
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== agentId) {
      throw new Error('the answer is not this agent')
    }
  } catch (error) {
    console.warn(`[agents] Could not read agent ${agentId} again after its ${family} settings changed:`, error)
    return
  }
  if (familyReadGenerations.get(key) !== generation) return
  if (family === 'mcp-settings') {
    const current = getAgentById(agentId)
    if (!current || !mcpBefore || record.user_id !== current.user_id || record.agentType !== current.agentType || !mcpRevisions || MCP_SETTINGS_FIELDS.some(field => !mcpRevisions![field]) ||
      mcpGeneration !== (mcpWriteGenerations.get(agentId) ?? 0) || (mcpWritesPending.get(agentId) ?? 0) > 0 || !sameJsonValue(mcpProjection(current), mcpProjection(mcpBefore))) return
    const projection = mcpProjection(record)
    agents = agents.map(row => { if (row.id !== agentId) return row; const next = { ...row } as Record<string, unknown>; for (const field of MCP_SETTINGS_FIELDS) { if (Object.hasOwn(projection, field)) next[field] = projection[field]; else delete next[field] }; return next as unknown as Agent })
    mcpDetailCuts = { ...mcpDetailCuts, [agentId]: { record: structuredClone(record), revisions: { ...mcpRevisions } } }
    return
  }
  if (family === 'auto-compact') {
    const current = getAgentById(agentId)
    if (!current || !autoCompactBefore || record.user_id !== current.user_id || record.agentType !== current.agentType ||
      autoCompactGeneration !== (autoCompactWriteGenerations.get(agentId) ?? 0) || (autoCompactWritesPending.get(agentId) ?? 0) > 0 ||
      !sameJsonValue(current.auto_compact_settings, autoCompactBefore.auto_compact_settings)) return
    agents = agents.map(row => {
      if (row.id !== agentId) return row
      const next = { ...row }
      if (Object.hasOwn(record, 'auto_compact_settings')) next.auto_compact_settings = record.auto_compact_settings as Agent['auto_compact_settings']
      else delete next.auto_compact_settings
      return next
    })
    return
  }
  if (family === 'instructions') {
    const current = getAgentById(agentId)
    if (!current || !instructionsBefore || record.user_id !== current.user_id || record.agentType !== current.agentType ||
      instructionsGeneration !== (instructionsWriteGenerations.get(agentId) ?? 0) || (instructionsWritesPending.get(agentId) ?? 0) > 0 ||
      !sameJsonValue(instructionsProjection(current), instructionsProjection(instructionsBefore))) return
    agents = agents.map(row => row.id === agentId ? withInstructions(row, record) : row)
    return
  }
  if (family === 'model-selection') {
    const current = getAgentById(agentId)
    if (!current || !modelBefore || record.user_id !== current.user_id || modelReadGeneration !== (modelWriteGenerations.get(agentId) ?? 0) ||
      (modelWritesPending.get(agentId) ?? 0) > 0 || !sameModelSelection('agent', modelBefore as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>)) return
    updateAgent(agentId, withModelSelection('agent', current as unknown as Record<string, unknown>, record) as Partial<Agent>)
    return
  }
  updateAgent(agentId, Object.fromEntries(fields.map((field) => [field, record[field]])) as Partial<Agent>)
}

// Function to load agents from database
export async function loadAgents(userId: string) {
  const reasoningReads = captureAgentReasoningReads()
  try {
    // Import DatabaseService dynamically to avoid circular dependencies
    const { DatabaseService } = await import('$lib/services/databaseRedis.client')
    const db = new DatabaseService()
    
    const data = await db.getAgents(userId)
    
    // Map database snake_case to frontend camelCase
    setAgents((data || []).map(a => ({
      ...a,
      model_reasoning_overrides: preserveNewerReasoningLeaves(a.id, a.model_reasoning_overrides,
        getAgentById(a.id)?.model_reasoning_overrides, reasoningReads.get(a.id) ?? 0),
      displayName: a.displayName || '', // Map displayName
      avatar_url: a.avatar || a.avatar_url || undefined
    })))
    
    return agents
  } catch (error) {
    console.error('Failed to load agents:', error)
    throw error
  }
}
