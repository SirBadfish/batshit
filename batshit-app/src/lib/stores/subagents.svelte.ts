import type { SubagentRow, AgentSubagentRow } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { SubagentType } from '$lib/utils/subagentType'
import { sameModelSelection, withModelSelection, isModelSelectionWrite } from '$lib/appActions/settings/modelSelectionBaseline'
import { INSTRUCTIONS_REVISION_HEADER, captureInstructionsBaseline, namesInstructions, type InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'

interface SubagentStore {
  subagents: SubagentRow[]
  loading: boolean
  error: string | null
  userId: string | null
}

let store = $state<SubagentStore>({
  subagents: [],
  loading: false,
  error: null,
  userId: null
})

// Base API URL for direct Redis API
const API_BASE = '/api/subagents'
const providerReadGenerations = new Map<string, number>()
const providerWriteGenerations = new Map<string, number>()
const providerWritesPending = new Map<string, number>()
const providerRefreshRequested = new Set<string>()
function drainProviderRefresh(id: string) {
  if ((providerWritesPending.get(id) ?? 0) > 0 || !providerRefreshRequested.delete(id)) return
  void refreshSubagentProviderSettingsFromServer(id)
}
/** Read-only invalidation: never adopts a previous owner, superseded row or pending write. */
export async function refreshSubagentProviderSettingsFromServer(id: string): Promise<void> {
  return readSubagentProviderSettings(id, true)
}
async function readSubagentProviderSettings(id: string, allowCatchUp: boolean): Promise<void> {
  const before = store.subagents.find(row => row.id === id), userId = store.userId
  if (!before || !userId || before.user_id !== userId) return
  if ((providerWritesPending.get(id) ?? 0) > 0) { providerRefreshRequested.add(id); return }
  const generation = (providerReadGenerations.get(id) ?? 0) + 1
  providerReadGenerations.set(id, generation)
  const writeGeneration = providerWriteGenerations.get(id) ?? 0
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { subagent } = await response.json()
    if (!subagent || subagent.id !== id || subagent.user_id !== userId || subagent.subagentType !== before.subagentType || subagent.created_at !== before.created_at) throw new Error('The answer is not this Subagent incarnation')
    const value = subagent.provider_specific_settings
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('The saved provider settings are malformed')
    if (store.userId !== userId) return
    const current = store.subagents.find(row => row.id === id)
    if (!current || current.user_id !== userId || current.subagentType !== before.subagentType || current.created_at !== before.created_at) return
    if (writeGeneration !== (providerWriteGenerations.get(id) ?? 0) || (providerWritesPending.get(id) ?? 0) > 0) {
      providerRefreshRequested.add(id)
      drainProviderRefresh(id)
      return
    }
    if (providerReadGenerations.get(id) !== generation) return
    if (current !== before && !sameJsonValue(current.provider_specific_settings, before.provider_specific_settings)) {
      // A different family changed this bag. One fresh read catches up, without replaying a save.
      if (allowCatchUp) await readSubagentProviderSettings(id, false)
      return
    }
    store.subagents = store.subagents.map(row => row === current ? { ...row, provider_specific_settings: value ?? null } : row)
  } catch (error) { console.warn(`[subagents] Could not refresh tool settings of ${id}:`, error) }
}

const identityReadGenerations = new Map<string, number>()
const modelReadGenerations = new Map<string, number>()
const modelWriteGenerations = new Map<string, number>()
const modelWritesPending = new Map<string, number>()
const modelRefreshRequested = new Set<string>()
function drainModelRefresh(id: string) {
  if ((modelWritesPending.get(id) ?? 0) > 0 || !modelRefreshRequested.delete(id)) return
  void refreshSubagentModelSelectionFromServer(id)
}
const instructionsReadGenerations = new Map<string, number>()
const instructionsWriteGenerations = new Map<string, number>()
const instructionsWritesPending = new Map<string, number>()
const instructionsRefreshRequested = new Set<string>()
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
function drainInstructionsRefresh(id: string) {
  if ((instructionsWritesPending.get(id) ?? 0) > 0 || !instructionsRefreshRequested.delete(id)) return
  void refreshSubagentInstructionsFromServer(id)
}

/** Value-free invalidation reads only this family's leaves, after its actual writes settle. */
export async function refreshSubagentInstructionsFromServer(id: string): Promise<void> {
  const before = store.subagents.find(row => row.id === id), userId = store.userId
  if (!before || !userId) return
  if ((instructionsWritesPending.get(id) ?? 0) > 0) { instructionsRefreshRequested.add(id); return }
  const generation = (instructionsReadGenerations.get(id) ?? 0) + 1
  instructionsReadGenerations.set(id, generation)
  const writeGeneration = instructionsWriteGenerations.get(id) ?? 0
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { subagent } = await response.json()
    if (!subagent || subagent.id !== id || subagent.user_id !== userId || subagent.subagentType !== before.subagentType) throw new Error('The answer is not this Subagent')
    if (store.userId !== userId || instructionsReadGenerations.get(id) !== generation ||
      (instructionsWriteGenerations.get(id) ?? 0) !== writeGeneration || (instructionsWritesPending.get(id) ?? 0) > 0) return
    store.subagents = store.subagents.map(row => {
      if (row.id !== id || row.subagentType !== before.subagentType || !sameJsonValue(instructionsProjection(row), instructionsProjection(before))) return row
      return withInstructions(row, subagent)
    })
  } catch (error) { console.warn(`[subagents] Could not refresh the instructions of ${id}:`, error) }
}

export async function refreshSubagentModelSelectionFromServer(id: string): Promise<void> {
  const before = store.subagents.find(row => row.id === id)
  const userId = store.userId
  if (!before || !userId) return
  if ((modelWritesPending.get(id) ?? 0) > 0) { modelRefreshRequested.add(id); return }
  const writeGeneration = modelWriteGenerations.get(id) ?? 0
  const generation = (modelReadGenerations.get(id) ?? 0) + 1
  modelReadGenerations.set(id, generation)
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { subagent } = await response.json()
    if (!subagent || subagent.id !== id || subagent.user_id !== userId) throw new Error('The answer is not this Subagent')
    if (store.userId !== userId || modelReadGenerations.get(id) !== generation || writeGeneration !== (modelWriteGenerations.get(id) ?? 0) || (modelWritesPending.get(id) ?? 0) > 0) return
    store.subagents = store.subagents.map(row => row.id === id && sameModelSelection('subagent', row as unknown as Record<string, unknown>, before as unknown as Record<string, unknown>)
      ? withModelSelection('subagent', row as unknown as Record<string, unknown>, subagent) as unknown as SubagentRow : row)
  } catch (error) { console.warn(`[subagents] Could not refresh the saved model of ${id}:`, error) }
}

/** Narrow live projection: failed/older reads preserve the cache, and a local
 * name save supersedes an in-flight read. Unrelated settings stay untouched. */
export async function refreshSubagentIdentityFromServer(id: string): Promise<void> {
  const before = store.subagents.find(row => row.id === id)
  const userId = store.userId
  if (!before || !userId) return
  const generation = (identityReadGenerations.get(id) ?? 0) + 1
  identityReadGenerations.set(id, generation)
  try {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { subagent } = await response.json()
    if (!subagent || subagent.id !== id || subagent.user_id !== userId || typeof subagent.displayName !== 'string' ||
      subagent.displayName.length > 200 || !subagent.displayName.isWellFormed()) throw new Error('The answer is not this Subagent identity')
    if (store.userId !== userId || identityReadGenerations.get(id) !== generation) return
    store.subagents = store.subagents.map(row => row.id === id && row === before
      ? { ...row, displayName: subagent.displayName } : row)
  } catch (error) { console.warn(`[subagents] Could not refresh the saved name of ${id}:`, error) }
}

/**
 * The server's own reason for a refusal, when it gave one. A delete that could not reach
 * batshit-server (2026-09-25, BL-139), a name another agent already uses (BL-187), or a save
 * the server refused (BL-286) says what to do; the bare status text ("Service Unavailable")
 * did not.
 */
async function describeRefusal(response: Response, action: string, subject = 'subagent') {
  const payload = await response.json().catch(() => null)
  const reason = typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : response.statusText
  return `Failed to ${action} ${subject}: ${reason}`
}

export function createSubagentStore() {
  return {
    get subagents() { return store.subagents },
    get loading() { return store.loading },
    get error() { return store.error },
    
    init(userId: string) {
      store.userId = userId
    },

    /** A successful authenticated GET updates the same cache that section reads observe. */
    acceptServerRecord(record: SubagentRow) {
      if (record.user_id !== store.userId) throw new Error('Subagent settings belong to another user')
      instructionsWriteGenerations.set(record.id, (instructionsWriteGenerations.get(record.id) ?? 0) + 1)
      store.subagents = store.subagents.map(existing => existing.id === record.id ? record : existing)
    },
    
    async load() {
      if (!store.userId) return
      
      store.loading = true
      store.error = null
      
      try {
        const response = await fetch(`${API_BASE}`)
        
        if (response.ok) {
          const data = await response.json()
          store.subagents = data.subagents || []
        } else {
          store.error = await describeRefusal(response, 'load', 'subagents')
          store.subagents = []
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to load subagents'
        console.error('Failed to load subagents:', err)
        store.subagents = []
      } finally {
        store.loading = false
      }
    },
    
    async create(subagent: {
      id?: string;  // Story 6.9c: Optional slug ID (API will generate if not provided)
      displayName: string;
      description?: string;
      subagentType?: SubagentType;
      specialty?: 'general' | 'n8n-specialist' | 'artifact';
      webhook_url?: string;
      workflowName?: string;  // Story 6.7c: n8n workflow name for Mode 3 detection
      system_prompt?: string;
      model?: string;
      primary_model_provider?: string;
      primary_model_name?: string;
      timeout_seconds?: number;
      max_tool_steps?: number;
      primary_model_temperature?: number;
      primary_model_max_tokens?: number;
      primary_model_top_p?: number;
      primary_model_frequency_penalty?: number;
      primary_model_presence_penalty?: number;
      include_global_prompt?: boolean;
      seed?: number;
      stop_sequences?: string[];
      provider_specific_settings?: Record<string, any>;
      credential_source?: string;
      avatar?: string | null;
      avatar_icon_ref?: IconRef | null;
      avatar_icon_fit?: AvatarIconFit | null;
    }) {
      if (!store.userId) throw new Error('Store not initialized')
      
      try {
        const response = await fetch(`${API_BASE}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(subagent)
        })
        
        if (response.ok) {
          const data = await response.json()
          const newSubagent = data.subagent
          
          store.subagents = [...store.subagents, newSubagent]
          
          return newSubagent
        } else {
          const errorMsg = await describeRefusal(response, 'create')
          store.error = errorMsg
          throw new Error(errorMsg)
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to create subagent'
        throw err
      }
    },
    
    async update(id: string, updates: Partial<{
      expectedModelSelection: string;
      expectedTypedFileTools: string;
      expectedInstructions: Partial<InstructionsRevisions>;
      displayName: string;
      subagentType: SubagentType;
      description?: string;
      workflowName?: string;  // Story 6.7c: n8n workflow name for Mode 3 detection
      system_prompt?: string;
      include_global_prompt?: boolean;
      model?: string;
      primary_model_provider?: string;
      primary_model_name?: string;
      timeout_seconds?: number | null;
      max_tool_steps?: number | null;
      primary_model_temperature?: number;
      primary_model_max_tokens?: number;
      primary_model_top_p?: number;
      primary_model_frequency_penalty?: number;
      primary_model_presence_penalty?: number;
      seed?: number;
      stop_sequences?: string[];
      provider_specific_settings?: Record<string, any>;
      credential_source?: string;
      avatar?: string | null;
      avatar_icon_ref?: IconRef | null;
      avatar_icon_fit?: AvatarIconFit | null;
    }>) {
      if (!store.userId) throw new Error('Store not initialized')
      const providerWrite = Object.hasOwn(updates, 'provider_specific_settings')
      if (providerWrite) {
        providerWriteGenerations.set(id, (providerWriteGenerations.get(id) ?? 0) + 1)
        providerReadGenerations.set(id, (providerReadGenerations.get(id) ?? 0) + 1)
        providerWritesPending.set(id, (providerWritesPending.get(id) ?? 0) + 1)
      }
      const instructionsWrite = namesInstructions(updates)
      const modelWrite = isModelSelectionWrite('subagent', updates)
      let knownSaved = false
      if (modelWrite) {
        modelWriteGenerations.set(id, (modelWriteGenerations.get(id) ?? 0) + 1)
        modelWritesPending.set(id, (modelWritesPending.get(id) ?? 0) + 1)
      }
      const modelGeneration = modelWriteGenerations.get(id) ?? 0
      if (instructionsWrite) {
        instructionsWriteGenerations.set(id, (instructionsWriteGenerations.get(id) ?? 0) + 1)
        instructionsWritesPending.set(id, (instructionsWritesPending.get(id) ?? 0) + 1)
      }
      const instructionsGeneration = instructionsWriteGenerations.get(id) ?? 0
      
      try {
        const response = await fetch(`${API_BASE}/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updates)
        })
        
        if (response.ok) {
          const data = await response.json()
          if (data.selectionSaved === true) knownSaved = true
          const updatedSubagent = data.subagent
          if (!updatedSubagent || typeof updatedSubagent !== 'object' || Array.isArray(updatedSubagent) || updatedSubagent.id !== id || updatedSubagent.user_id !== store.userId) {
            if (knownSaved || data.typedFileToolsSaved === true) return { subagent: null, selectionSaved: data.selectionSaved === true, typedFileTools: data.typedFileTools, configuration: data.configuration, readback: 'unavailable' }
            throw new Error('The save response did not confirm this Subagent. Read its current settings before another choice.')
          }
          knownSaved = true
          
          const instructionsSuperseded = instructionsGeneration !== (instructionsWriteGenerations.get(id) ?? 0) ||
            (instructionsWritesPending.get(id) ?? 0) > (instructionsWrite ? 1 : 0)
          if (instructionsSuperseded) instructionsRefreshRequested.add(id)
          const modelSuperseded = modelGeneration !== (modelWriteGenerations.get(id) ?? 0) || (modelWritesPending.get(id) ?? 0) > (modelWrite ? 1 : 0)
          if (modelSuperseded) modelRefreshRequested.add(id)
          store.subagents = store.subagents.map(sa => sa.id === id
            ? modelSuperseded ? withModelSelection('subagent', instructionsSuperseded ? withInstructions(updatedSubagent, sa) : updatedSubagent, sa)
              : instructionsSuperseded ? withInstructions(updatedSubagent, sa) : updatedSubagent : sa)
          return { subagent: updatedSubagent as SubagentRow,
            selectionSaved: data.selectionSaved === true, typedFileTools: data.typedFileTools, configuration: data.configuration,
            instructionsBaseline: captureInstructionsBaseline('subagent', updatedSubagent, response.headers.get(INSTRUCTIONS_REVISION_HEADER)) }
        } else {
          if (instructionsWrite && response.status === 409) instructionsRefreshRequested.add(id)
          // BL-286: the server's reason (an override it refused, a required webhook URL), which
          // the Subagent panel's save error shows, not the bare status text.
          const refused = await response.clone().json().catch(() => null)
          const errorMsg = await describeRefusal(response, 'update')
          store.error = errorMsg
          throw Object.assign(new Error(errorMsg), { status: response.status, ...(refused?.typedFileTools ? { typedFileTools: refused.typedFileTools } : {}), ...(typeof refused?.code === 'string' ? { code: refused.code } : {}) })
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to update subagent'
        throw err
      } finally {
        if (providerWrite) {
          providerWritesPending.set(id, Math.max(0, (providerWritesPending.get(id) ?? 1) - 1))
          drainProviderRefresh(id)
        }
        if (modelWrite) {
          modelWritesPending.set(id, Math.max(0, (modelWritesPending.get(id) ?? 1) - 1))
          modelWriteGenerations.set(id, (modelWriteGenerations.get(id) ?? 0) + 1)
          if (knownSaved) modelRefreshRequested.add(id)
          drainModelRefresh(id)
        }
        if (instructionsWrite) {
          instructionsWritesPending.set(id, Math.max(0, (instructionsWritesPending.get(id) ?? 1) - 1))
          instructionsWriteGenerations.set(id, (instructionsWriteGenerations.get(id) ?? 0) + 1)
          if (knownSaved) instructionsRefreshRequested.add(id)
        }
        drainInstructionsRefresh(id)
      }
    },
    
    async delete(id: string) {
      if (!store.userId) throw new Error('Store not initialized')
      
      try {
        const response = await fetch(`${API_BASE}/${id}`, {
          method: 'DELETE'
        })
        
        if (response.ok) {
          const payload = await response.json().catch(() => null)
          store.subagents = store.subagents.filter(sa => sa.id !== id)
          return typeof payload?.notice === 'string' ? payload.notice : null
        } else {
          const errorMsg = await describeRefusal(response, 'delete')
          store.error = errorMsg
          throw new Error(errorMsg)
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to delete subagent'
        throw err
      }
    },
    
    // Get subagents attached to a specific agent
    async getAgentSubagents(agentId: string): Promise<SubagentRow[]> {
      if (!store.userId) return []
      
      try {
        const response = await fetch(`/api/agents/${agentId}/subagents`)
        
        if (response.ok) {
          const data = await response.json()
          return data.subagents || []
        } else {
          console.error('Failed to get agent subagents:', response.statusText)
          return []
        }
      } catch (err) {
        console.error('Failed to get agent subagents:', err)
        return []
      }
    },
    
    // Attach/detach subagents to/from an agent
    async updateAgentSubagents(agentId: string, subagentIds: string[]) {
      if (!store.userId) throw new Error('Store not initialized')
      
      try {
        const response = await fetch(`/api/agents/${agentId}/subagents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ subagentIds })
        })
        
        if (!response.ok) {
          const errorMsg = await describeRefusal(response, 'update', 'agent subagents')
          store.error = errorMsg
          throw new Error(errorMsg)
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to update agent subagents'
        throw err
      }
    }
  }
}

export const subagentStore = createSubagentStore()
