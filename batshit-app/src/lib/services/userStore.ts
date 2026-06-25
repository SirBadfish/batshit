// User store operations for Redis
// Handles user settings, projects, clips, and folders

import { RedisStoreBase } from './redisCore'
import type { UserSettingsRow, ClipRow, ChatFolderRow, ProjectRow } from '$lib/types/database'

export type UserSettingsRuntimeDefaults = {
  nativeExecutionBackend: 'docker_sandbox' | 'apple_container' | null
}

export type UserSettingsEnvelope = {
  settings: UserSettingsRow
  runtimeDefaults: UserSettingsRuntimeDefaults
}

export class UserStore extends RedisStoreBase {
  // User Settings
  /**
   * Loads user settings plus the server-computed runtime defaults rider in one call.
   * Transport/server failures THROW (`USER_SETTINGS_UNAVAILABLE: ...`) — fabricating
   * defaults here hid real outages from prompt compilation (G-0031/G-0152a). A missing
   * settings row is a legitimate empty state and resolves to defaults instead.
   */
  async getUserSettingsEnvelope(userId: string): Promise<UserSettingsEnvelope> {
    let response: any
    try {
      response = await this.apiCall(`/users/${userId}/settings`)
    } catch (error) {
      throw new Error(
        `USER_SETTINGS_UNAVAILABLE: failed to load user settings: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const backendCandidate = response?.runtime_defaults?.native_execution_backend
    const runtimeDefaults: UserSettingsRuntimeDefaults = {
      nativeExecutionBackend:
        backendCandidate === 'docker_sandbox' || backendCandidate === 'apple_container'
          ? backendCandidate
          : null
    }

    if (response && response.settings) {
      return { settings: response.settings as UserSettingsRow, runtimeDefaults }
    }

    // No settings row saved yet (fresh install) — a real empty state, not an error fallback.
    const now = new Date().toISOString()
    return {
      settings: {
        id: `settings_${userId}`,
        user_id: userId,
        global_custom_system_prompt: '',
        theme: 'system',
        created_at: now,
        updated_at: now
      } as UserSettingsRow,
      runtimeDefaults
    }
  }

  async getUserSettings(userId: string) {
    return (await this.getUserSettingsEnvelope(userId)).settings
  }

  async updateUserSettings(userId: string, updates: {
    displayName?: string
    avatar_url?: string
    global_custom_system_prompt?: string
    theme?: string
    font_size?: string
  }) {
    await this.apiCall(`/users/${userId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  // Projects
  async getProjects(userId: string) {
    // /api/projects returns { projects: [...] } — unwrap it. The wrapper object used to
    // be cast as the array itself, so every Array.isArray consumer silently saw "no
    // projects" and n8n default-project resolution never worked (G-0148/PLD-026).
    const data = await this.apiCall(`/projects`)
    return (Array.isArray(data?.projects) ? data.projects : []) as ProjectRow[]
  }

  async saveProject(project: any) {
    const response = await this.apiCall('/projects', {
      method: 'POST',
      body: JSON.stringify(project)
    })
    return response
  }

  async updateProject(projectId: string, userId: string, updates: any) {
    await this.apiCall(`/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  async deleteProject(projectId: string, userId: string) {
    await this.apiCall(`/projects/${projectId}`, {
      method: 'DELETE'
    })
  }

  // Clips
  async getClips(userId: string) {
    const clips = await this.apiCall(`/clips`)
    return clips as ClipRow[]
  }

  async getClip(clipId: string) {
    const clip = await this.apiCall(`/clips/${clipId}`)
    return clip as ClipRow
  }

  async createClip(clip: Partial<ClipRow>) {
    const response = await this.apiCall('/clips', {
      method: 'POST',
      body: JSON.stringify(clip)
    })

    return response as ClipRow
  }

  async updateClip(clipId: string, updates: Partial<ClipRow>) {
    const response = await this.apiCall(`/clips/${clipId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })

    return response as ClipRow
  }

  async deleteClip(clipId: string) {
    await this.apiCall(`/clips/${clipId}`, {
      method: 'DELETE'
    })
  }

  // Folders
  async getFolders(): Promise<ChatFolderRow[]> {
    const folders = await this.apiCall('/folders')
    return folders as ChatFolderRow[]
  }

  async createFolder(folder: Partial<ChatFolderRow>): Promise<ChatFolderRow> {
    const response = await this.apiCall('/folders', {
      method: 'POST',
      body: JSON.stringify(folder)
    })
    return response as ChatFolderRow
  }

  async updateFolder(folderId: string, updates: Partial<ChatFolderRow>) {
    await this.apiCall(`/folders/${folderId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  async deleteFolder(
    folderId: string,
    options: { deleteSessions?: boolean } = {}
  ): Promise<{ success: boolean; moved_to?: string; deleted_sessions?: number }> {
    const params = options.deleteSessions ? '?deleteSessions=true' : ''
    const response = await this.apiCall(`/folders/${folderId}${params}`, {
      method: 'DELETE'
    })
    return response
  }
}

export const userStore = new UserStore()
