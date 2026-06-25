import type { SubagentRow, AgentSubagentRow } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { SubagentType } from '$lib/utils/subagentType'

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

export function createSubagentStore() {
  return {
    get subagents() { return store.subagents },
    get loading() { return store.loading },
    get error() { return store.error },
    
    init(userId: string) {
      store.userId = userId
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
          store.error = `Failed to load subagents: ${response.statusText}`
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
      specialty?: 'general' | 'n8n-specialist' | 'claude-code' | 'artifact';
      webhook_url?: string;
      workflowName?: string;  // Story 6.7c: n8n workflow name for Mode 3 detection
      system_prompt?: string;
      model?: string;
      primary_model_provider?: string;
      primary_model_name?: string;
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
          const errorMsg = `Failed to create subagent: ${response.statusText}`
          store.error = errorMsg
          throw new Error(errorMsg)
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to create subagent'
        throw err
      }
    },
    
    async update(id: string, updates: Partial<{
      displayName: string;
      subagentType: SubagentType;
      description?: string;
      workflowName?: string;  // Story 6.7c: n8n workflow name for Mode 3 detection
      system_prompt?: string;
      model?: string;
      primary_model_provider?: string;
      primary_model_name?: string;
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
          const updatedSubagent = data.subagent
          
          store.subagents = store.subagents.map(sa =>
            sa.id === id ? updatedSubagent : sa
          )
        } else {
          const errorMsg = `Failed to update subagent: ${response.statusText}`
          store.error = errorMsg
          throw new Error(errorMsg)
        }
      } catch (err) {
        store.error = err instanceof Error ? err.message : 'Failed to update subagent'
        throw err
      }
    },
    
    async delete(id: string) {
      if (!store.userId) throw new Error('Store not initialized')
      
      try {
        const response = await fetch(`${API_BASE}/${id}`, {
          method: 'DELETE'
        })
        
        if (response.ok) {
          store.subagents = store.subagents.filter(sa => sa.id !== id)
        } else {
          const errorMsg = `Failed to delete subagent: ${response.statusText}`
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
          const errorMsg = `Failed to update agent subagents: ${response.statusText}`
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
