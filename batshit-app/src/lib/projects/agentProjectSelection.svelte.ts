import { untrack } from 'svelte'

import * as projectStore from '$lib/stores/projects.svelte'
import type { Project } from '$lib/stores/projects.svelte'
import { forgetLastProjectForAgent, resolveProjectIdForAgent } from '$lib/utils/projectAgentMemory'

export interface AgentProjectSelectionSource {
  /**
   * The current agent's loaded record: its id and saved `default_project_id` (null or blank:
   * Default). Null or undefined while no record is loaded (an empty or failed agent list): then
   * nothing is chosen and no remembered pick is judged, since its saved default is unknown.
   */
  agent: () => { id: string; default_project_id?: string | null } | null | undefined
  /** Runs after the selection rule changed the current project (null: none). */
  onSelected?: (project: Project | null) => void
}

/**
 * BL-2372 review A2: a landed save that names an agent's `default_project_id` outranks any older
 * sidebar pick for that agent, also when the agent is not the current one. The selection owner
 * only sees the CURRENT agent's value change, so a default set from X to Y and back to X while
 * another agent was current would otherwise let the pick made against X come back. Agent
 * Settings calls this where such a save lands (`updateAgentCollections`).
 */
export function noteSavedDefaultProject(agentId: string | null | undefined) {
  forgetLastProjectForAgent(agentId)
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Set the store's current project to what the agent should have now (`resolveProjectIdForAgent`).
 * Returns the project when the selection changed, `undefined` when it already matched.
 */
export function applyAgentProjectSelection(
  agentId: string | null | undefined,
  defaultProjectId: string | null | undefined
): Project | null | undefined {
  const projects = projectStore.getSelectableProjects()
  const nextId = resolveProjectIdForAgent({ agentId, projects, defaultProjectId })
  if (nextId === projectStore.getCurrentProjectId()) return undefined
  projectStore.setCurrentProject(nextId)
  return projectStore.getCurrentProject()
}

/**
 * BL-2372/BL-2373: the ONE owner of which project an agent works in. It must run on the chat page
 * whether or not the Projects sidebar is open (the sidebar's selector exists only while it is
 * open, and its old copy of this rule left the last pick in the store for every later agent and
 * every later save). It picks again when the agent changes, when that agent's saved default
 * changes (the save outranks an older sidebar pick, with no reload), and when the selectable
 * projects change (a list load, a deleted project, the Default Project Path set or cleared).
 *
 * It depends only on those three values; the store writes it makes are untracked, so its own
 * selection never runs it again (the `$effect` trap in the Fragility Map).
 */
export function watchAgentProjectSelection(source: AgentProjectSelectionSource) {
  const agentId = $derived(normalizeId(source.agent()?.id))
  const defaultProjectId = $derived(normalizeId(source.agent()?.default_project_id))
  const selectableProjectIds = $derived(
    projectStore
      .getSelectableProjects()
      .map((project) => project.id)
      .join('\n')
  )

  $effect(() => {
    const currentAgentId = agentId
    const savedDefaultProjectId = defaultProjectId
    void selectableProjectIds
    if (!currentAgentId) return

    untrack(() => {
      const selected = applyAgentProjectSelection(currentAgentId, savedDefaultProjectId)
      if (selected !== undefined) source.onSelected?.(selected)
    })
  })
}
