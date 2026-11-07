<script lang="ts">
  import { ChevronDown, Settings, PlusCircle } from '@lucide/svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as projectStore from '$lib/stores/projects.svelte';
  import * as agentStore from '$lib/stores/agents.svelte';
  import { onMount } from 'svelte';
  import { ProjectService } from '$lib/services/projects';
  import { loadProjectTree } from '$lib/projects/fileTreeActions';
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte';
  import { DEFAULT_PROJECT_ICON_REF } from '$lib/icons/iconCatalog';
  import { normalizeIconRef } from '$lib/icons/iconLegacy';
  import { toast } from 'svelte-sonner';
  import { rememberLastProjectForAgent } from '$lib/utils/projectAgentMemory';
  
  const { data } = $props();
  
  // State
  let open = $state(false);
  function openProjectsSettings(mode: 'list' | 'create' = 'list') {
    window.dispatchEvent(
      new CustomEvent('batshit:open-settings', {
        detail: { tab: 'projects', mode }
      })
    );
  }
  
  // Get reactive values. BL-2373: the Default Project (when the user has a Default Project Path)
  // is listed first, beside the saved projects.
  const projects = $derived(projectStore.getSelectableProjects());
  const currentProject = $derived(projectStore.getCurrentProject());
  const projectTriggerLabel = $derived.by(() =>
    currentProject ? `Select project (${currentProject.name})` : 'Select project'
  );

  // BL-2372: which project an agent gets when the sidebar opens, after an agent switch, or after
  // a saved default changes is decided by `watchAgentProjectSelection` (mounted by
  // ProjectsSidebar, which exists whether or not this selector is open). The selector only records
  // the user's own pick, against the agent's saved default so that a newer save outranks it.
  
  // Load projects on mount
  onMount(() => {
    // Run async initialization
    (async () => {
      if (data?.user?.id) {
        try {
          const projectService = new ProjectService();
          const loadedProjects = await projectService.loadProjects(data.user.id);
          projectStore.setProjects(loadedProjects);
        } catch (error) {
          console.error('Error loading projects:', error);
          toast.error(error instanceof Error ? error.message : 'Failed to load projects');
        }
      }
    })();
    
    // BL-2391: a changed root or exclusions of the shown project reloads its tree from the store
    // (`ProjectsSidebar`); the old `project-settings-updated` listener here had no sender.
  });
  
  // Handle project selection — lazy load: only the root level is fetched here,
  // the background @ mention index walk runs after (see fileTreeActions).
  async function handleSelect(projectId: string) {
    projectStore.setCurrentProject(projectId);
    rememberLastProjectForAgent({
      agentId: agentStore.getCurrentAgentId(),
      projectId,
      projects: projectStore.getSelectableProjects(),
      defaultProjectId: agentStore.getCurrentAgent()?.default_project_id
    });
    open = false;

    const project = projectStore.getSelectableProjects().find(p => p.id === projectId);
    if (project) {
      await loadProjectTree(project, { notify: true });
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
