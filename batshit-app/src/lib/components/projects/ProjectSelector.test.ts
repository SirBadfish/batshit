import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import ProjectSelector from './ProjectSelector.svelte'

const projects = [
  {
    id: 'project-1',
    name: 'Batshit Workspace',
    root_path: '/Users/example/batshit'
  }
]

vi.mock('$lib/stores/projects.svelte', () => ({
  getProjects: () => projects,
  getCurrentProject: () => projects[0],
  getCurrentProjectId: () => projects[0].id,
  setProjects: vi.fn(),
  setCurrentProject: vi.fn()
}))

vi.mock('$lib/services/projects', () => ({
  ProjectService: class {
    async loadProjects() {
      return projects
    }
  }
}))

vi.mock('$lib/projects/fileTreeActions', () => ({
  loadProjectTree: vi.fn(async () => {}),
  refreshProjectTree: vi.fn(async () => {})
}))

describe('ProjectSelector accessibility labels', () => {
  it('labels the trigger with the current project name', () => {
    render(ProjectSelector as any, {
      props: {
        data: {
          user: { id: 'josh' }
        }
      }
    })

    expect(
      screen.getByRole('button', { name: 'Select project (Batshit Workspace)' })
    ).toBeInTheDocument()
  })
})
