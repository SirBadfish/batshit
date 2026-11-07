import { render } from '@testing-library/svelte'
import { flushSync, tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const actions = vi.hoisted(() => ({
  loadProjectTree: vi.fn(async () => {}),
  refreshProjectTree: vi.fn(async () => {})
}))
vi.mock('$lib/projects/fileTreeActions', () => actions)
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))

import ProjectsSidebar from './ProjectsSidebar.svelte'
import * as agentStore from '$lib/stores/agents.svelte'
import * as projectStore from '$lib/stores/projects.svelte'

function project(id: string, root: string) {
  return { id, user_id: 'josh', name: id, root_path: root, created_at: '', updated_at: '' }
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await tick()
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('projectsSidebarCollapsed', 'false')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects: projectStore.getProjects() }), { status: 200 })))
  // jsdom's 1024px window is too narrow for the sidebar beside an open right panel.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  projectStore.setProjects([project('project_site', '/fixture/site'), project('project_app', '/fixture/app')])
  agentStore.setAgents([
    { id: 'bob', name: 'Bob', default_project_id: 'project_site' } as any,
    { id: 'chloe', name: 'Chloe', default_project_id: 'project_app' } as any
  ])
  agentStore.setCurrentAgent('bob')
})

afterEach(() => {
  vi.unstubAllGlobals()
  actions.loadProjectTree.mockClear()
  agentStore.setAgents([])
  projectStore.setCurrentProject(null)
  projectStore.setProjects([])
  localStorage.clear()
})

/**
 * Review A3: when the right panel closes and the Projects sidebar comes back, a project chosen
 * while the sidebar was hidden must load its tree, as opening it by hand does.
 */
describe('ProjectsSidebar after the right panel hid it', () => {
  it('loads the tree of a project chosen while it was hidden', async () => {
    const view = render(ProjectsSidebar as any, { props: { data: { user: { id: 'josh' } }, rightPanelOpen: false } })
    await settle()
    expect(projectStore.getCurrentProjectId()).toBe('project_site')

    await view.rerender({ data: { user: { id: 'josh' } }, rightPanelOpen: true })
    await settle()
    actions.loadProjectTree.mockClear()

    // While the sidebar is hidden, another agent becomes current: its project is chosen, unloaded.
    agentStore.setCurrentAgent('chloe')
    flushSync()
    await settle()
    expect(projectStore.getCurrentProjectId()).toBe('project_app')
    expect(actions.loadProjectTree).not.toHaveBeenCalled()

    await view.rerender({ data: { user: { id: 'josh' } }, rightPanelOpen: false })
    await settle()
    expect(actions.loadProjectTree).toHaveBeenCalledWith(expect.objectContaining({ id: 'project_app' }), expect.anything())
  })
})

// BL-2391: editing the shown saved project's Root Path or exclusions in Settings.
describe('ProjectsSidebar when the shown project changes in place', () => {
  it('loads the new folder after a Root Path change, and refreshes in place after an exclusions change', async () => {
    render(ProjectsSidebar as any, { props: { data: { user: { id: 'josh' } }, rightPanelOpen: false } })
    await settle()
    expect(projectStore.getCurrentProjectId()).toBe('project_site')
    actions.loadProjectTree.mockClear()

    projectStore.updateProject('project_site', { root_path: '/fixture/site-moved' })
    flushSync()
    await settle()
    expect(actions.loadProjectTree).toHaveBeenCalledWith(expect.objectContaining({ id: 'project_site', root_path: '/fixture/site-moved' }))

    // Exclusions alone: the loaded tree refreshes, keeping open folders.
    projectStore.setFileTreeRoot([])
    actions.refreshProjectTree.mockClear()
    projectStore.updateProject('project_site', { custom_exclusions: ['**/tmp/**'] })
    flushSync()
    await settle()
    expect(actions.refreshProjectTree).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project_site', custom_exclusions: ['**/tmp/**'] }),
      { notify: false }
    )
  })
})
