import { render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectSelector from './ProjectSelector.svelte'

const mocks = vi.hoisted(() => ({
  projects: [
    {
      id: 'project-1',
      name: 'Batshit Workspace',
      root_path: '/Users/example/batshit'
    }
  ] as Array<{ id: string; name: string; root_path: string }>,
  loadProjects: vi.fn(),
  setCurrentProject: vi.fn()
}))

vi.mock('$lib/stores/projects.svelte', () => ({
  getProjects: () => mocks.projects,
  getSelectableProjects: () => mocks.projects,
  getCurrentProject: () => mocks.projects[0] ?? null,
  getCurrentProjectId: () => mocks.projects[0]?.id ?? null,
  setProjects: vi.fn(),
  setCurrentProject: mocks.setCurrentProject
}))

vi.mock('$lib/services/projects', () => ({
  ProjectService: class {
    async loadProjects() {
      return mocks.loadProjects()
    }
  }
}))

vi.mock('$lib/projects/fileTreeActions', () => ({
  loadProjectTree: vi.fn(async () => {}),
  refreshProjectTree: vi.fn(async () => {})
}))

describe('ProjectSelector accessibility labels', () => {
  beforeEach(() => {
    mocks.projects = [
      {
        id: 'project-1',
        name: 'Batshit Workspace',
        root_path: '/Users/example/batshit'
      }
    ]
    mocks.loadProjects.mockReset()
    mocks.loadProjects.mockImplementation(async () => mocks.projects)
    mocks.setCurrentProject.mockReset()
  })

  // BL-2372: opening the sidebar must not choose the agent's project; the selection owner
  // (`watchAgentProjectSelection`, mounted by ProjectsSidebar) does, open or closed.
  it('mounting the selector loads the list but does not select a project', async () => {
    render(ProjectSelector as any, { props: { data: { user: { id: 'josh' } } } })
    await waitFor(() => expect(mocks.loadProjects).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(mocks.setCurrentProject).not.toHaveBeenCalled()
  })

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

  it('does not interrupt first-run onboarding when no projects exist', async () => {
    mocks.projects = []
    const openedSettings: CustomEvent[] = []
    const handleOpenSettings = (event: Event) => openedSettings.push(event as CustomEvent)
    window.addEventListener('batshit:open-settings', handleOpenSettings)

    try {
      render(ProjectSelector as any, {
        props: {
          data: {
            user: { id: 'new-admin' },
            userSettings: null
          }
        }
      })

      await waitFor(() => expect(mocks.loadProjects).toHaveBeenCalledTimes(1))
      expect(openedSettings).toEqual([])
      expect(screen.getByRole('button', { name: 'Select project' })).toBeInTheDocument()
    } finally {
      window.removeEventListener('batshit:open-settings', handleOpenSettings)
    }
  })
})
