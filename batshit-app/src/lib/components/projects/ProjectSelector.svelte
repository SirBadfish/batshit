<script lang="ts">
  import { ChevronDown, Settings, PlusCircle } from '@lucide/svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as projectStore from '$lib/stores/projects.svelte';
  import * as agentStore from '$lib/stores/agents.svelte';
  import { onMount } from 'svelte';
  import { ProjectService } from '$lib/services/projects';
  import { loadProjectTree, refreshProjectTree } from '$lib/projects/fileTreeActions';
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte';
  import { DEFAULT_PROJECT_ICON_REF } from '$lib/icons/iconCatalog';
  import { normalizeIconRef } from '$lib/icons/iconLegacy';
  import { toast } from 'svelte-sonner';
  import {
    rememberLastProjectForAgent,
    resolveProjectIdForAgent
  } from '$lib/utils/projectAgentMemory';
  
  const { data } = $props();
  
  // State
  let open = $state(false);
  let lastRestoredAgentId = $state<string | null>(null);
  function openProjectsSettings(mode: 'list' | 'create' = 'list') {
    window.dispatchEvent(
      new CustomEvent('batshit:open-settings', {
        detail: { tab: 'projects', mode }
      })
    );
  }
  
  // Get reactive values
  const projects = $derived(projectStore.getProjects());
  const currentProject = $derived(projectStore.getCurrentProject());
  const currentAgentId = $derived(agentStore.getCurrentAgentId());
  const projectTriggerLabel = $derived.by(() =>
    currentProject ? `Select project (${currentProject.name})` : 'Select project'
  );

  function rememberProjectForCurrentAgent(projectId: string) {
    rememberLastProjectForAgent(agentStore.getCurrentAgentId(), projectId);
  }

  function resolveProjectForAgent(agentId: string | null, availableProjects: projectStore.Project[]) {
    return resolveProjectIdForAgent({
      agentId,
      projects: availableProjects,
      defaultProjectId: agentStore.getCurrentAgent()?.default_project_id
    });
  }

  async function restoreProjectForAgent(
    agentId: string | null,
    availableProjects: projectStore.Project[],
    options: { notify?: boolean } = {}
  ) {
    if (availableProjects.length === 0) return;
    const projectId = resolveProjectForAgent(agentId, availableProjects);
    if (!projectId) return;
    if (agentId) {
      lastRestoredAgentId = agentId;
    }
    await handleSelect(projectId, { notify: options.notify ?? false });
  }

  $effect(() => {
    const agentId = currentAgentId;
    const projectIds = projects.map((project) => project.id).join('|');
    if (!agentId || !projectIds || agentId === lastRestoredAgentId) return;
    lastRestoredAgentId = agentId;
    void restoreProjectForAgent(agentId, projects, { notify: false });
  });
  
  // Load projects on mount
  onMount(() => {
    // Run async initialization
    (async () => {
      if (data?.user?.id) {
        try {
          const projectService = new ProjectService();
          const loadedProjects = await projectService.loadProjects(data.user.id);
          projectStore.setProjects(loadedProjects);
          
          if (loadedProjects.length > 0) {
            await restoreProjectForAgent(agentStore.getCurrentAgentId(), loadedProjects, { notify: false });
          }
        } catch (error) {
          console.error('Error loading projects:', error);
          toast.error(error instanceof Error ? error.message : 'Failed to load projects');
        }
      }
    })();
    
    // Listen for project settings updates
    const handleProjectUpdate = async (event: Event) => {
      const customEvent = event as CustomEvent;
      const { projectId } = customEvent.detail;
      if (projectId === projectStore.getCurrentProjectId()) {
        // Exclusions/settings changed: refresh clears the per-directory cache,
        // reloads the root, and re-fetches the expanded directories.
        const project = projectStore.getProjects().find(p => p.id === projectId);
        if (project) {
          await refreshProjectTree(project, { notify: false });
        }
      }
    };
    
    window.addEventListener('project-settings-updated', handleProjectUpdate);
    
    // Cleanup listener on unmount
    return () => {
      window.removeEventListener('project-settings-updated', handleProjectUpdate);
    };
  });
  
  // Handle project selection — lazy load: only the root level is fetched here,
  // the background @ mention index walk runs after (see fileTreeActions).
  async function handleSelect(projectId: string, options: { notify?: boolean } = {}) {
    const notify = options.notify ?? true;
    projectStore.setCurrentProject(projectId);
    rememberProjectForCurrentAgent(projectId);
    open = false;

    const project = projectStore.getProjects().find(p => p.id === projectId);
    if (project) {
      await loadProjectTree(project, { notify });
    }
  }
  
  // Handle manage projects click
  function handleManageClick() {
    open = false;
    openProjectsSettings('list');
  }
  
  // Handle create new project click
  function handleCreateClick() {
    open = false;
    openProjectsSettings('create');
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger 
    class="project-selector-trigger"
    aria-label={projectTriggerLabel}
    title={projectTriggerLabel}
    data-testid="project-selector"
    data-ab-control="project-selector"
  >
    <div class="project-selector-value">
      {#if currentProject}
        <IconRenderer
          ref={normalizeIconRef(currentProject.icon_ref, DEFAULT_PROJECT_ICON_REF)}
          class="project-selector-icon"
          iconClass="project-selector-rendered-icon"
          label={currentProject.name}
        />
        <span class="project-selector-label">
          {currentProject.name}
        </span>
      {:else}
        <span class="project-selector-placeholder">Select Project</span>
      {/if}
    </div>
    <ChevronDown class="project-selector-chevron" />
    <span class="project-selector-screen-reader">{projectTriggerLabel}</span>
  </DropdownMenu.Trigger>
  
  <DropdownMenu.Content align="start" class="project-selector-menu">
    <DropdownMenu.Label>Select Project</DropdownMenu.Label>
    
    {#if projects.length > 0}
      <DropdownMenu.RadioGroup value={currentProject?.id || ''}>
        {#each projects as project (project.id)}
          <DropdownMenu.RadioItem
            value={project.id}
            onSelect={() => handleSelect(project.id)}
            class="project-selector-menu-item"
          >
            <IconRenderer
              ref={normalizeIconRef(project.icon_ref, DEFAULT_PROJECT_ICON_REF)}
              class="project-selector-icon"
              iconClass="project-selector-rendered-icon"
              label={project.name}
            />
            <span class="project-selector-label">
              {project.name}
            </span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    {:else}
      <DropdownMenu.Item disabled>
        <span class="project-selector-placeholder">No projects available</span>
      </DropdownMenu.Item>
    {/if}
    
    <DropdownMenu.Separator />
    
    <DropdownMenu.Item onSelect={handleManageClick}>
      <Settings class="project-selector-menu-icon" />
      <span>Manage Projects...</span>
    </DropdownMenu.Item>
    
    <DropdownMenu.Item onSelect={handleCreateClick}>
      <PlusCircle class="project-selector-menu-icon" />
      <span>Create New Project...</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.project-selector-trigger) {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 32px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    white-space: nowrap;
    font-size: 0.75rem;
    font-weight: 500;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.project-selector-trigger:hover) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.project-selector-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 1px var(--bs-app-primary-soft);
  }

  :global(.project-selector-trigger:disabled) {
    pointer-events: none;
    opacity: 0.5;
  }

  .project-selector-value {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  :global(.project-selector-icon),
  :global(.project-selector-rendered-icon),
  :global(.project-selector-chevron),
  :global(.project-selector-menu-icon) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--bs-app-muted-text);
  }

  :global(.project-selector-menu-icon) {
    margin-right: 0.5rem;
  }

  .project-selector-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-selector-placeholder {
    color: var(--bs-app-muted-text);
  }

  :global(.project-selector-menu) {
    width: 200px;
  }

  :global(.project-selector-menu-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .project-selector-screen-reader {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
