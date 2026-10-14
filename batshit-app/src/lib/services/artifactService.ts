// Artifact service for separate artifact storage (NOT part of zip system)
// Artifacts have their own Redis storage pattern: artifact:{id}
// This is completely separate from the zip system

import type { Message } from '$lib/stores/messages.svelte'
import type { ArtifactBrainType, ArtifactModelConfig } from '$lib/types/artifacts'
import type { IconRef } from '$lib/icons/iconTypes'
import { ApiCallError } from './redisCore'

export interface ArtifactRow {
  id: string
  user_id: string
  name: string
  slug: string
  type: string
  content?: string
  mode: 'edit' | 'published'
  version: number
  description?: string
  tags?: string[]
  metadata?: Record<string, any>
  blueprint?: string | null
  icon?: string | null
  icon_ref?: IconRef | null

  // Session tracking
  created_in_session: string
  last_edited_session: string
  
  // AI settings
  brain_type?: ArtifactBrainType
  ai_enabled: boolean
  webhook_url?: string | null
  model?: string | null // legacy: use model_config
  model_config?: ArtifactModelConfig | null
  system_prompt?: string | null
  custom_prompt?: string | null
  
  // Widget placement
  zone?: 'header' | 'panel' | 'trigger' | null
  widget_position?: 'header-icon' | 'header-dropdown' | 'panel-tab'
  widget_order?: number  // For ordering within a zone

  // Agent use controls
  agent_use_enabled?: boolean
  agent_access_scope?: 'all' | 'selected'
  agent_allowlist?: string[] | null

  // Timestamps
  created_at: string
  updated_at: string
  published_at?: string
  
  // Version history
  versions?: ArtifactVersion[]
}

export interface ArtifactVersion {
  id: string
  version: number
  content?: string
  description?: string
  created_at: string
  created_by: string
}

export class ArtifactService {
  private apiUrl = '/api/artifacts'
  
  // Helper method for API calls
  private async apiCall(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${this.apiUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    })
    
    if (!response.ok) {
      // The server's own sentence, never its raw JSON (the same rule as every store client's
      // `apiCall`, bug sweep 2026-09-18): Agent Settings shows this message when saving fails.
      throw new ApiCallError(response.status, await response.text())
    }
    
    return response.json()
  }
  
  // Get all user artifacts
  async getArtifacts(userId: string): Promise<ArtifactRow[]> {
    try {
      const artifacts = await this.apiCall(`?userId=${userId}`)
      return artifacts as ArtifactRow[]
    } catch (error) {
      console.error('Failed to get artifacts:', error)
      return []
    }
  }
  
  // Get single artifact
  async getArtifact(artifactId: string): Promise<ArtifactRow | null> {
    try {
      const artifact = await this.apiCall(`/${artifactId}`)
      return artifact as ArtifactRow
    } catch (error) {
      console.error('Failed to get artifact:', error)
      return null
    }
  }
  
  // Create new artifact
  async createArtifact(artifact: Partial<ArtifactRow>): Promise<ArtifactRow> {
    const response = await this.apiCall('', {
      method: 'POST',
      body: JSON.stringify(artifact)
    })
    
    return response as ArtifactRow
  }
  
  // Update existing artifact
  async updateArtifact(artifactId: string, updates: Partial<ArtifactRow>): Promise<ArtifactRow> {
    const response = await this.apiCall(`/${artifactId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
    
    return response as ArtifactRow
  }
  
  /**
   * BL-544: turn ONE agent or Subagent on or off for one artifact (Settings > Agents > Access).
   * The server adds or removes that id against the list as stored now; Agent Use and the
   * all-agents switch stay as they are. Answers the artifact as stored.
   */
  async setArtifactAgentAccess(artifactId: string, agentId: string, enabled: boolean): Promise<ArtifactRow> {
    const response = await this.apiCall(`/${encodeURIComponent(artifactId)}/agent-access`, {
      method: 'PUT',
      body: JSON.stringify({ agentId, enabled })
    })

    return response as ArtifactRow
  }

  // Restore an older version as the new current one (the server re-checks it like any save).
  async restoreVersion(
    artifactId: string,
    targetVersion: number
  ): Promise<{ success: boolean; newVersion: number; message?: string }> {
    return await this.apiCall('/versions', {
      method: 'PUT',
      body: JSON.stringify({ artifactId, targetVersion })
    })
  }

  // Delete artifact
  async deleteArtifact(artifactId: string): Promise<void> {
    await this.apiCall(`/${artifactId}`, {
      method: 'DELETE'
    })
  }

  // Change artifact mode
  async changeMode(artifactId: string, mode: 'edit' | 'published'): Promise<ArtifactRow> {
    return await this.updateArtifact(artifactId, { mode })
  }
}

// Export singleton instance
export const artifactService = new ArtifactService()
