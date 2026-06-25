import type { Project } from '$lib/stores/projects.svelte'
import type { ProjectPreferences } from '$lib/types/database'

export class ProjectService {
  constructor() {}

  private async getErrorMessage(response: Response, fallback: string): Promise<string> {
    const text = await response.text()
    if (!text) return fallback

    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.error === 'string' && parsed.error.trim()) {
        return parsed.error
      }
    } catch {
      // Plain-text responses are still useful to show to the user.
    }

    return text
  }
  
  async loadProjects(userId: string): Promise<Project[]> {
    const response = await fetch('/api/projects')
    if (!response.ok) {
      throw new Error(await this.getErrorMessage(response, 'Failed to load projects'))
    }

    const { projects } = await response.json()
    return projects || []
  }
  
  async createProject(project: Partial<Project>): Promise<Project> {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project)
    })
    
    if (!response.ok) {
      throw new Error(await this.getErrorMessage(response, 'Failed to create project'))
    }
    
    const { project: newProject } = await response.json()
    return newProject
  }
  
  async updateProject(projectId: string, updates: Partial<Project>) {
    const response = await fetch('/api/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, updates })
    })
    
    if (!response.ok) {
      throw new Error(await this.getErrorMessage(response, 'Failed to update project'))
    }
    
    const { project: updated } = await response.json()
    return updated
  }
  
  async deleteProject(projectId: string) {
    const response = await fetch('/api/projects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId })
    })
    
    if (!response.ok) {
      throw new Error(await this.getErrorMessage(response, 'Failed to delete project'))
    }
  }

  async loadPreferences(): Promise<ProjectPreferences | null> {
    const response = await fetch('/api/projects/preferences')
    if (!response.ok) {
      throw new Error(await this.getErrorMessage(response, 'Failed to load project preferences'))
    }

    const { preferences } = await response.json()
    return preferences || null
  }

  async savePreferences(payload: { defaultWorkspacePath?: string | null }) {
    const response = await fetch('/api/projects/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || 'Failed to save project preferences')
    }

    const { preferences } = await response.json()
    return preferences as ProjectPreferences
  }
}
