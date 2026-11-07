import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as projectStore from '$lib/stores/projects.svelte'
import type { Project } from '$lib/stores/projects.svelte'
import { DEFAULT_PROJECT_ID } from '$lib/projects/defaultProject'
import { rememberLastProjectForAgent } from '$lib/utils/projectAgentMemory'
import { noteSavedDefaultProject, watchAgentProjectSelection } from './agentProjectSelection.svelte'

function project(id: string, root: string): Project {
  return {
    id,
    user_id: 'josh',
    name: id,
    root_path: root,
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z'
  }
}

const destroyers: Array<() => void> = []

/**
 * The chat page with the Projects sidebar CLOSED: nothing but the selection owner runs (the
 * sidebar's selector, which held the old copy of the rule, is not mounted). Agents and their
 * saved defaults change the way Agent Settings changes them in the shared agent store.
 */
function mountChatPage(initial: { agentId: string; defaults: Record<string, string | null> }) {
  let agentId = $state(initial.agentId)
  let defaults = $state<Record<string, string | null>>({ ...initial.defaults })
  // The agent store's list; false models an empty or failed agent list load.
  let agentsLoaded = $state(true)
  const selected: Array<string | null> = []

  const destroy = $effect.root(() => {
    watchAgentProjectSelection({
      agent: () => (agentsLoaded ? { id: agentId, default_project_id: defaults[agentId] ?? null } : null),
      onSelected: (next) => selected.push(next?.id ?? null)
    })
  })
  destroyers.push(destroy)
  flushSync()

  return {
    selected,
    switchAgent(next: string) {
      agentId = next
      flushSync()
    },
    /** What Agent Settings does when a save naming the default lands: the store, then the hook. */
    saveDefault(forAgent: string, projectId: string | null) {
      defaults = { ...defaults, [forAgent]: projectId }
      noteSavedDefaultProject(forAgent)
      flushSync()
    },
    setAgentsLoaded(loaded: boolean) {
      agentsLoaded = loaded
      flushSync()
    },
    /** What ProjectSelector does when the user picks a project in the open sidebar. */
    pickInSidebar(projectId: string) {
      projectStore.setCurrentProject(projectId)
      rememberLastProjectForAgent({
        agentId,
        projectId,
        projects: projectStore.getSelectableProjects(),
        defaultProjectId: defaults[agentId] ?? null
      })
      flushSync()
    }
  }
}

function currentRoot() {
  return projectStore.getCurrentProject()?.root_path ?? null
}

beforeEach(() => {
  localStorage.clear()
  projectStore.setCurrentProject(null)
  projectStore.setDefaultProjectPath('/Users/tester/Workspace')
  projectStore.setProjects([project('project_batshit', '/Users/tester/batshit'), project('project_site', '/Users/tester/site')])
})

afterEach(() => {
  while (destroyers.length) destroyers.pop()?.()
  projectStore.setProjects([])
  projectStore.setDefaultProjectPath(null)
  projectStore.setCurrentProject(null)
  localStorage.clear()
})

describe('BL-2372/BL-2373: the agent project selection owner', () => {
  it('an agent on Default shows the Default Project, not the first saved project', () => {
    mountChatPage({ agentId: 'bob', defaults: { bob: null } })
    expect(projectStore.getCurrentProjectId()).toBe(DEFAULT_PROJECT_ID)
    expect(currentRoot()).toBe('/Users/tester/Workspace')
  })

  it("a sidebar pick stays this agent's, and never follows another agent with the sidebar closed", () => {
    const page = mountChatPage({ agentId: 'bob', defaults: { bob: null, chloe: null } })
    page.pickInSidebar('project_batshit')
    expect(currentRoot()).toBe('/Users/tester/batshit')

    page.switchAgent('chloe')
    expect(currentRoot()).toBe('/Users/tester/Workspace')

    page.switchAgent('bob')
    expect(currentRoot()).toBe('/Users/tester/batshit')
  })

  it('a saved default reaches the chat at once and outranks the older sidebar pick, with no reload', () => {
    const page = mountChatPage({ agentId: 'bob', defaults: { bob: null } })
    page.pickInSidebar('project_batshit')

    page.saveDefault('bob', 'project_site')
    expect(currentRoot()).toBe('/Users/tester/site')

    // Back to Default: the save wins again; the old pick does not come back.
    page.saveDefault('bob', null)
    expect(projectStore.getCurrentProjectId()).toBe(DEFAULT_PROJECT_ID)
    expect(currentRoot()).toBe('/Users/tester/Workspace')
  })

  // Review A2: the owner only sees the CURRENT agent's default change.
  it("a default saved X to Y and back to X while another agent is current still outranks the agent's older pick", () => {
    const page = mountChatPage({ agentId: 'bob', defaults: { bob: 'project_site', chloe: null } })
    page.pickInSidebar('project_batshit')
    page.switchAgent('chloe')

    page.saveDefault('bob', null)
    page.saveDefault('bob', 'project_site')

    page.switchAgent('bob')
    expect(currentRoot()).toBe('/Users/tester/site')
  })

  // Review nit: an empty or failed agent list must not judge (and forget) a real pick.
  it('an agent list that is empty or failed to load keeps the selection and the remembered pick', () => {
    const page = mountChatPage({ agentId: 'bob', defaults: { bob: 'project_site' } })
    page.pickInSidebar('project_batshit')

    page.setAgentsLoaded(false)
    expect(currentRoot()).toBe('/Users/tester/batshit')

    page.setAgentsLoaded(true)
    page.switchAgent('bob')
    expect(currentRoot()).toBe('/Users/tester/batshit')
  })

  it('Agent Settings reports every landed save that names a default project', async () => {
    const { readFileSync } = await import('node:fs')
    const panel = readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8')
    const landing = panel.slice(panel.indexOf('function updateAgentCollections('))
    expect(landing.slice(0, 400)).toContain('if ("default_project_id" in updates) noteSavedDefaultProject(id);')
  })

  it('follows the Default Project Path being cleared and set again', () => {
    mountChatPage({ agentId: 'bob', defaults: { bob: null } })
    projectStore.setDefaultProjectPath('')
    flushSync()
    expect(projectStore.getCurrentProject()).toBeNull()

    projectStore.setDefaultProjectPath('/Users/tester/Other')
    flushSync()
    expect(currentRoot()).toBe('/Users/tester/Other')
  })

  it('a deleted current project is not replaced by another saved project', () => {
    mountChatPage({ agentId: 'bob', defaults: { bob: 'project_batshit' } })
    expect(currentRoot()).toBe('/Users/tester/batshit')

    projectStore.deleteProject('project_batshit')
    flushSync()
    expect(projectStore.getCurrentProject()).toBeNull()
  })

  it('its own selection does not run it again', () => {
    const page = mountChatPage({ agentId: 'bob', defaults: { bob: null } })
    const runs = page.selected.length
    projectStore.setFileTreeRoot([])
    projectStore.updateProject('project_site', { name: 'Site' })
    flushSync()
    expect(page.selected.length).toBe(runs)
  })
})
