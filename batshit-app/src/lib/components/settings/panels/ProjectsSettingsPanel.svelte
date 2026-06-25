<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import * as Card from '$lib/components/ui/card'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import {
    AlertCircle,
    ChevronDown,
    FolderPlus,
    Loader2,
    Pencil,
    RefreshCcw,
    Shield,
    Trash2,
    X
  } from '@lucide/svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { ProjectService } from '$lib/services/projects'
  import type { Project } from '$lib/stores/projects.svelte'
  import * as projectStore from '$lib/stores/projects.svelte'
  import type { ProjectPreferences } from '$lib/types/database'
  import { PROJECT_DEFAULT_EXCLUSIONS, PROJECT_SECURITY_EXCLUSIONS } from '$lib/projects/exclusions'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { DEFAULT_PROJECT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { iconRefKey, type IconRef } from '$lib/icons/iconTypes'
  import { dispatchProjectPreferencesUpdated } from '$lib/utils/liveSettingsEvents'

  const SECURITY_EXCLUSIONS: string[] = [...PROJECT_SECURITY_EXCLUSIONS]
  const DEFAULT_EXCLUSIONS: string[] = [...PROJECT_DEFAULT_EXCLUSIONS]

  type PanelData = {
    user?: { id: string } | null
  } | null
  type ProjectsPanelMode = 'list' | 'create'

  interface ProjectFormState {
    id: string | null
    name: string
    root_path: string
    max_depth: string
    use_default_exclusions: boolean
    custom_exclusions: string
    rules_json: string
    iconRef: IconRef
  }

  interface ValidationSuccess {
    ok: true
    parsedRules: any | null
    maxDepth: number | null
  }

  interface ValidationFailure {
    ok: false
    error: string
  }

  type ValidationResult = ValidationSuccess | ValidationFailure

  const EMPTY_FORM: ProjectFormState = {
    id: null,
    name: '',
    root_path: '',
    max_depth: '',
    use_default_exclusions: true,
    custom_exclusions: '',
    rules_json: '',
    iconRef: DEFAULT_PROJECT_ICON_REF
  }

  const projectService = new ProjectService()
  let preferences = $state<ProjectPreferences | null>(null)
  let defaultWorkspacePath = $state('')
  let preferencesLoading = $state(true)
  let preferencesError = $state<string | null>(null)
  let prefSaveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let prefPersistedValue = $state('')
  let prefHydrating = $state(false)

  let {
    data = null,
    initialMode = null,
    initialModeNonce = 0
  }: {
    data?: PanelData
    initialMode?: ProjectsPanelMode | null
    initialModeNonce?: number
  } = $props()
  let lastAppliedModeNonce = $state<number | null>(null)

  let projects = $state<Project[]>([])
  let listLoading = $state(true)
  let listError = $state<string | null>(null)
  let selectedProjectId = $state<string | null>(null)

  let projectForm = $state<ProjectFormState>({ ...EMPTY_FORM })
  let formPersistedSignature = $state<string | null>(null)
  let formHydrating = $state(false)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let validationError = $state<string | null>(null)
  let deleteBusy = $state(false)
  let deleteDisclosureOpen = $state(false)

  let createMode = $state(false)
  let createForm = $state<ProjectFormState>({ ...EMPTY_FORM })
  let createBusy = $state(false)
  let createError = $state<string | null>(null)
  let createCustomExclusionsEditorOpen = $state(false)
  let createRulesEditorOpen = $state(false)
  let projectCustomExclusionsEditorOpen = $state(false)
  let projectRulesEditorOpen = $state(false)

  onMount(async () => {
    await Promise.all([loadProjects(), loadPreferences()])
  })

  $effect(() => {
    if (listLoading) return
    if (lastAppliedModeNonce === initialModeNonce) return

    if (initialMode === 'create') {
      handleStartCreate()
    } else if (initialMode === 'list') {
      createMode = false
      createError = null
      if (!selectedProjectId && projects.length > 0) {
        const firstProject = projects[0]
        if (firstProject) {
          selectProject(firstProject)
        }
      }
    }

    lastAppliedModeNonce = initialModeNonce
  })

  async function loadProjects() {
    listLoading = true
    listError = null

    try {
      const loaded = await projectService.loadProjects(data?.user?.id ?? '')
      projects = loaded
      projectStore.setProjects(loaded)

      if (loaded.length > 0) {
        const existing = selectedProjectId ? loaded.find((project) => project.id === selectedProjectId) : undefined
        const initial = existing ?? loaded[0]
        if (initial) {
          selectProject(initial)
        }
      } else {
        untrack(() => {
          selectedProjectId = null
          projectForm = { ...EMPTY_FORM }
          formPersistedSignature = null
        })
      }
    } catch (error) {
      console.error('Failed to load projects:', error)
      listError = error instanceof Error ? error.message : 'Failed to load projects'
      projects = []
      projectStore.setProjects([])
      untrack(() => {
        selectedProjectId = null
        projectForm = { ...EMPTY_FORM }
        formPersistedSignature = null
      })
    } finally {
      listLoading = false
    }
  }

  async function loadPreferences() {
    preferencesLoading = true
    preferencesError = null
    prefHydrating = true
    try {
      const loaded = await projectService.loadPreferences()
      preferences = loaded
      defaultWorkspacePath = loaded?.default_workspace_path ?? ''
      prefPersistedValue = defaultWorkspacePath.trim()
    } catch (error) {
      console.error('Failed to load project preferences:', error)
      preferencesError =
        error instanceof Error ? error.message : 'Failed to load preferences'
    } finally {
      prefHydrating = false
      preferencesLoading = false
    }
  }

  function selectProject(project: Project) {
    createMode = false
    createError = null

    formHydrating = true
    untrack(() => {
      selectedProjectId = project.id
      projectForm = normaliseProject(project)
      formPersistedSignature = makeFormSignature(projectForm)
      validationError = null
      saveError = null
      saveState = 'idle'
    })
    formHydrating = false
  }

  function normaliseProject(project: Project): ProjectFormState {
    const exclusions = project.custom_exclusions ?? []
    const exclusionSet = new Set(exclusions)
    const useDefaults = DEFAULT_EXCLUSIONS.every((item) => exclusionSet.has(item))

    const customOnly = exclusions.filter(
      (pattern) =>
        !SECURITY_EXCLUSIONS.includes(pattern) && !DEFAULT_EXCLUSIONS.includes(pattern)
    )

    return {
      id: project.id,
      name: project.name ?? '',
      root_path: project.root_path ?? '',
      max_depth: project.max_depth != null ? String(project.max_depth) : '',
      use_default_exclusions: useDefaults,
      custom_exclusions: customOnly.join('\n'),
      rules_json: project.rules_json ? JSON.stringify(project.rules_json, null, 2) : '',
      iconRef: normalizeIconRef(project.icon_ref, DEFAULT_PROJECT_ICON_REF)
    }
  }

  function makeFormSignature(form: ProjectFormState) {
    return JSON.stringify({
      id: form.id ?? '',
      name: form.name.trim(),
      root_path: form.root_path.trim(),
      max_depth: form.max_depth.trim(),
      use_default_exclusions: form.use_default_exclusions,
      custom_exclusions: form.custom_exclusions
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      rules_json: form.rules_json.trim(),
      icon_ref: iconRefKey(form.iconRef)
    })
  }

  function validateProjectForm(form: ProjectFormState): ValidationResult {
    if (!form.name.trim()) {
      return { ok: false, error: 'Project name is required.' }
    }

    if (!form.root_path.trim()) {
      return { ok: false, error: 'Root path is required.' }
    }

    if (!form.root_path.trim().startsWith('/')) {
      return { ok: false, error: 'Root path must be an absolute path (start with /).' }
    }

    let parsedRules: any | null = null
    if (form.rules_json.trim()) {
      try {
        parsedRules = JSON.parse(form.rules_json)
        if (!parsedRules || typeof parsedRules !== 'object' || Array.isArray(parsedRules)) {
          return {
            ok: false,
            error: 'AI rules must be a JSON object (key/value pairs).'
          }
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'AI rules must be valid JSON.'
        }
      }
    }

    let maxDepth: number | null = null
    if (form.max_depth.trim()) {
      const value = Number(form.max_depth)
      if (!Number.isFinite(value) || value < 0) {
        return { ok: false, error: 'Max depth must be a non-negative number.' }
      }
      maxDepth = value
    }

    return { ok: true, parsedRules, maxDepth }
  }

  function buildProjectPayload(
    form: ProjectFormState,
    validation: ValidationSuccess
  ): Partial<Project> {
    const exclusions = new Set<string>(SECURITY_EXCLUSIONS)

    if (form.use_default_exclusions) {
      for (const pattern of DEFAULT_EXCLUSIONS) {
        exclusions.add(pattern)
      }
    }

    form.custom_exclusions
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => exclusions.add(line))

    return {
      name: form.name.trim(),
      root_path: form.root_path.trim(),
      max_depth: validation.maxDepth ?? undefined,
      rules_json: validation.parsedRules,
      custom_exclusions: Array.from(exclusions),
      icon_ref: form.iconRef
    }
  }

  function getProjectRulesFieldLabel() {
    return 'Project Rules (JSON)'
  }

  function validateRulesEditorValue(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return

    let parsedRules: any
    try {
      parsedRules = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Project rules must be valid JSON.')
    }

    if (!parsedRules || typeof parsedRules !== 'object' || Array.isArray(parsedRules)) {
      throw new Error('Project rules must be a JSON object (key/value pairs).')
    }
  }

  async function persistProjectForm(nextForm: ProjectFormState) {
    if (!selectedProjectId) return

    const validation = validateProjectForm(nextForm)
    if (!validation.ok) {
      validationError = validation.error
      throw new Error(validation.error)
    }

    validationError = null

    const response = await fetch('/api/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: selectedProjectId,
        updates: buildProjectPayload(nextForm, validation)
      })
    })

    if (!response.ok) {
      const message = await extractError(response, 'Failed to save project')
      throw new Error(message)
    }

    const result = await response.json()
    const updated: Project = result.project

    projects = projects.map((project) => (project.id === updated.id ? updated : project))
    projectStore.updateProject(updated.id, updated)

    formHydrating = true
    untrack(() => {
      projectForm = normaliseProject(updated)
      formPersistedSignature = makeFormSignature(projectForm)
    })
    formHydrating = false

    untrack(() => {
      saveState = 'saved'
      saveError = null
    })

    setTimeout(() => {
      untrack(() => {
        if (saveState === 'saved') {
          saveState = 'idle'
        }
      })
    }, 2000)
  }

  const saveProject = debounce(
    async (nextForm: ProjectFormState) => {
      try {
        await persistProjectForm(nextForm)
      } catch (error) {
        console.error('Project save failed:', error)
        untrack(() => {
          saveState = 'idle'
          saveError = error instanceof Error ? error.message : 'Failed to save project'
        })
      }
    },
    600
  )

  const savePreferences = debounce(async (value: string) => {
    try {
      const saved = await projectService.savePreferences({
        defaultWorkspacePath: value.length ? value : null
      })
      preferences = saved
      prefPersistedValue = value
      prefSaveState = 'saved'
      dispatchProjectPreferencesUpdated({
        defaultWorkspacePath: value.length ? value : null
      })
      setTimeout(() => {
        if (prefSaveState === 'saved') {
          prefSaveState = 'idle'
        }
      }, 2000)
    } catch (error) {
      console.error('Failed to save project preferences:', error)
      prefSaveState = 'idle'
      preferencesError =
        error instanceof Error ? error.message : 'Failed to save preferences'
    }
  }, 600)

  $effect(() => {
    if (preferencesLoading || prefHydrating) return
    const trimmed = defaultWorkspacePath.trim()
    if (trimmed === prefPersistedValue) {
      return
    }
    if (trimmed.length > 0 && !trimmed.startsWith('/')) {
      preferencesError = 'Default workspace path must be absolute.'
      prefSaveState = 'idle'
      return
    }
    preferencesError = null
    prefSaveState = 'saving'
    savePreferences(trimmed)
  })

  $effect(() => {
    if (listLoading || formHydrating || createMode) return
    if (!selectedProjectId) return

    const signature = makeFormSignature(projectForm)
    if (!formPersistedSignature || signature === formPersistedSignature) {
      return
    }

    const validation = validateProjectForm(projectForm)
    if (!validation.ok) {
      validationError = validation.error
      return
    }

    validationError = null
    saveState = 'saving'
    saveProject(projectForm)
  })

  async function handleCreateProject() {
    createBusy = true
    createError = null

    const validation = validateProjectForm(createForm)
    if (!validation.ok) {
      createError = validation.error
      createBusy = false
      return
    }

    try {
      const payload = buildProjectPayload(createForm, validation)
      const created = await projectService.createProject(payload)

      projects = [...projects, created]
      projectStore.addProject(created)

      toast.success(`Project "${created.name}" created`)

      createForm = { ...EMPTY_FORM }
      createMode = false
      selectProject(created)
    } catch (error) {
      console.error('Failed to create project:', error)
      createError = error instanceof Error ? error.message : 'Failed to create project'
    } finally {
      createBusy = false
    }
  }

  async function handleDeleteProject() {
    if (!selectedProjectId) return
    deleteBusy = true
    saveError = null

    try {
      const response = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to delete project')
        throw new Error(message)
      }

      projects = projects.filter((project) => project.id !== selectedProjectId)
      projectStore.deleteProject(selectedProjectId)

      toast.success('Project deleted')

      if (projects.length > 0) {
        selectProject(projects[0])
      } else {
        untrack(() => {
          selectedProjectId = null
          projectForm = { ...EMPTY_FORM }
          formPersistedSignature = null
        })
      }
    } catch (error) {
      console.error('Failed to delete project:', error)
      saveError = error instanceof Error ? error.message : 'Failed to delete project'
    } finally {
      deleteBusy = false
    }
  }

  function saveCreateCustomExclusionsFromEditor(nextValue: string) {
    createForm = { ...createForm, custom_exclusions: nextValue }
  }

  function saveCreateRulesFromEditor(nextValue: string) {
    validateRulesEditorValue(nextValue)
    createForm = { ...createForm, rules_json: nextValue }
  }

  async function saveProjectCustomExclusionsFromEditor(nextValue: string) {
    if (!selectedProjectId) return

    saveState = 'saving'
    saveError = null

    try {
      await persistProjectForm({
        ...projectForm,
        custom_exclusions: nextValue
      })
    } catch (error) {
      console.error('Failed to save custom exclusions:', error)
      saveState = 'idle'
      saveError = error instanceof Error ? error.message : 'Failed to save custom exclusions'
      throw error
    }
  }

  async function saveProjectRulesFromEditor(nextValue: string) {
    if (!selectedProjectId) return

    validateRulesEditorValue(nextValue)
    saveState = 'saving'
    saveError = null

    try {
      await persistProjectForm({
        ...projectForm,
        rules_json: nextValue
      })
    } catch (error) {
      console.error('Failed to save project rules:', error)
      saveState = 'idle'
      saveError = error instanceof Error ? error.message : 'Failed to save project rules'
      throw error
    }
  }

  function handleStartCreate() {
    createMode = true
    createError = null
    createForm = { ...EMPTY_FORM }
    validationError = null
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const payload = await response.json()
      if (payload?.error) return payload.error
      if (typeof payload === 'string') return payload
      return fallback
    } catch {
      return fallback
    }
  }
</script>

{#if listLoading}
  <div class="flex items-center justify-center batshit-settings-empty-state">
    <Loader2 class="mr-2 h-4 w-4 animate-spin" />
    Loading projects…
  </div>
{:else if listError}
  <Card.Root>
    <Card.Header>
      <Card.Title class="batshit-settings-title-danger flex items-center gap-2">
        <AlertCircle class="h-4 w-4" />
        Failed to load projects
      </Card.Title>
      <Card.Description>{listError}</Card.Description>
    </Card.Header>
    <Card.Content class="flex gap-3">
      <Button variant="outline" onclick={loadProjects}>
        <RefreshCcw  />
        Retry
      </Button>
    </Card.Content>
  </Card.Root>
{:else}
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1">
          <BatshitIcon id="projects" class="h-5 w-5 text-muted-foreground" />
          <h3 class="batshit-settings-section-title">Projects</h3>
          <SettingsInfoMenu ariaLabel="About Projects">
            <p>
              Projects define the filesystem roots agents can see and work inside. Each project can
              also add exclusions and optional AI rules for that workspace.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={loadProjects}>
          <RefreshCcw  />
          Refresh
        </Button>
        <Button size="sm" onclick={handleStartCreate}>
          <FolderPlus  />
          New Project
        </Button>
      </div>
    </div>

    <div class="batshit-settings-surface">
      <div class="space-y-4">
        <SettingsAccordionCard
          name="project-settings-cards"
          title="Default Project Path"
          batshitIcon="projects"
          open
        >
          {#snippet info()}
            <SettingsInfoMenu ariaLabel="About Default Project Path">
              <p>
                Used by all agent modes when no Project is selected. Leave it blank to fall back to
                the Batshit working directory instead.
              </p>
              <p class="mt-2">
                This must be an absolute path such as <code>/path/to/project</code>.
              </p>
            </SettingsInfoMenu>
          {/snippet}
          {#snippet actions()}
            <SettingsSaveStatus
              state={preferencesError ? 'error' : prefSaveState}
              error={preferencesError}
              savedLabel="Path Saved"
            />
          {/snippet}
          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label.Label class="batshit-settings-form-label">Path</Label.Label>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  placeholder="/Users/me/projects/my-app"
                  value={defaultWorkspacePath}
                  disabled={preferencesLoading}
                  oninput={(event) => (defaultWorkspacePath = (event.target as HTMLInputElement).value)}
                />
              </div>
            </div>
          </div>
        </SettingsAccordionCard>

        <div class="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card.Root class="batshit-settings-card batshit-settings-card-default">
          <Card.Header class="pb-2">
            <div class="flex items-center gap-1">
              <Card.Title>Saved Projects</Card.Title>
              <SettingsInfoMenu ariaLabel="About Saved Projects">
                <p>Pick a project to edit or create a new one when you need a separate filesystem boundary.</p>
              </SettingsInfoMenu>
            </div>
          </Card.Header>
          <Card.Content class="batshit-settings-card-content-flush">
            {#if projects.length === 0}
              <div class="batshit-settings-empty-state">
                No projects yet. Create one to define file system boundaries for agents.
              </div>
            {:else}
              <div class="settings-sidebar-items">
                {#each projects as project (project.id)}
	                  <button
	                    type="button"
	                    class="settings-sidebar-item settings-sidebar-item-with-avatar"
	                    data-state={project.id === selectedProjectId && !createMode ? 'active' : 'inactive'}
	                    onclick={() => selectProject(project)}
	                  >
                      <div class="settings-sidebar-item-media pt-0.5">
                        <div class="batshit-settings-icon-frame h-9 w-9">
                          <IconRenderer
                            ref={normalizeIconRef(project.icon_ref, DEFAULT_PROJECT_ICON_REF)}
                            class="h-5 w-5 text-muted-foreground"
                            iconClass="h-4 w-4"
                            label={project.name}
                          />
                        </div>
                      </div>
                      <div class="settings-sidebar-item-content">
	                    <span class="settings-sidebar-item-title truncate">{project.name}</span>
	                    <span class="settings-sidebar-item-subtext truncate">{project.root_path}</span>
                      </div>
	                  </button>
                {/each}
              </div>
            {/if}
          </Card.Content>
        </Card.Root>

	        <div class="space-y-4">
          {#if createMode}
            <Card.Root class="batshit-settings-card batshit-settings-card-default">
              <Card.Header>
                <div class="flex items-center gap-1">
                  <Card.Title>Create Project</Card.Title>
                  <SettingsInfoMenu ariaLabel="About Create Project">
                    <p>Pick the root folder agents can access and set any optional exclusions or AI rules for that workspace.</p>
                  </SettingsInfoMenu>
                </div>
              </Card.Header>
              <Card.Content class="space-y-4">
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="create-name" class="batshit-settings-form-label">Project Name</Label.Label>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="create-name"
                        placeholder="My project"
                        bind:value={createForm.name}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Project Icon</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Icon">
                          <p>
                            This icon represents the project itself. Folders and files still use automatic
                            icons based on their type.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <IconPicker bind:value={createForm.iconRef} triggerLabel="Choose Icon" />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="create-root" class="batshit-settings-form-label">Root Path</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Root Path">
                          <p>
                            Agents are sandboxed to this directory and any subdirectories you explicitly
                            allow beneath it.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="create-root"
                        placeholder="/path/to/my-app"
                        bind:value={createForm.root_path}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="create-depth" class="batshit-settings-form-label">Max Depth</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Max Depth">
                          <p>
                            Optional recursion depth when Batshit indexes this project. Leave it blank to
                            use the system default depth.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="create-depth"
                        type="number"
                        min="0"
                        placeholder="10"
                        bind:value={createForm.max_depth}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row is-spine-toggle">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Default Exclusions</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Default Exclusions">
                          <p>
                            Automatically skips common build output, caches, and other high-noise folders
                            so agent file access stays cleaner by default.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-inline-status">
                      <span class="batshit-settings-form-meta">{createForm.use_default_exclusions ? 'Enabled' : 'Disabled'}</span>
                      <Switch.Root bind:checked={createForm.use_default_exclusions} />
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <p class="batshit-settings-form-label">Custom Exclusions</p>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-compact-action">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => (createCustomExclusionsEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <p class="batshit-settings-form-label">{getProjectRulesFieldLabel()}</p>
                        <SettingsInfoMenu ariaLabel="About Project Rules JSON">
                          <p>
                            These are structured project hints, not hard enforcement. When this project
                            is the active or default project context, Batshit injects the JSON into the
                            AI context as <code>project_rules_json</code>.
                          </p>
                          <p class="mt-2">
                            Good use cases: preferred language, framework, package manager, test
                            command, or repo conventions. Use Root Path and Exclusions for real hard
                            boundaries.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-compact-action">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => (createRulesEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>
                </div>

                {#if createError}
                  <div class="batshit-settings-inline-alert is-danger flex items-center gap-2">
                    <AlertCircle class="h-4 w-4" />
                    {createError}
                  </div>
                {/if}

                <div class="flex items-center gap-3">
                  <Button onclick={handleCreateProject} disabled={createBusy}>
                    {#if createBusy}
                      <Loader2 class="animate-spin" />
                    {/if}
                    Create Project
                  </Button>
                  <Button variant="ghost" onclick={() => (createMode = false)} disabled={createBusy}>
                    <X aria-hidden="true" />

                    Cancel
                  </Button>
                </div>
              </Card.Content>
            </Card.Root>
          {:else if !selectedProjectId}
            <Card.Root class="batshit-settings-card batshit-settings-card-default">
              <Card.Header>
                <div class="flex items-center gap-1">
                  <Card.Title>Select a Project</Card.Title>
                  <SettingsInfoMenu ariaLabel="About Project Settings">
                    <p>
                      Projects define the filesystem sandbox for your agents. Root path, exclusions,
                      and AI rules all live here.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </Card.Header>
              <Card.Content class="batshit-settings-card-caption">
                Select or create a project to edit its settings.
              </Card.Content>
            </Card.Root>
          {:else}
            <SettingsAccordionCard
              name="projects-settings-cards"
              title="Project Settings"
              batshitIcon="projects"
              contentClass="space-y-6"
              open
            >
              {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Project Settings">
                    <p>
                      Projects define the filesystem sandbox for your agents. Root path, exclusions,
                      and AI rules all live here.
                    </p>
                  </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                <SettingsSaveStatus
                  state={saveError ? 'error' : saveState}
                  error={saveError}
                  savedLabel="Project Saved"
                />
              {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="project-name" class="batshit-settings-form-label">Project Name</Label.Label>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="project-name"
                        placeholder="My project"
                        bind:value={projectForm.name}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="project-root" class="batshit-settings-form-label">Root Path</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Root Path">
                          <p>
                            Agents are sandboxed to this directory and any subdirectories you explicitly
                            allow beneath it.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="project-root"
                        placeholder="/path/to/my-app"
                        bind:value={projectForm.root_path}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Project Icon</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Icon">
                          <p>
                            This icon represents the project itself. Folder and file icons are automatic
                            and follow the file tree icon set.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <IconPicker bind:value={projectForm.iconRef} triggerLabel="Choose Icon" />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label for="project-depth" class="batshit-settings-form-label">Max Depth</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Project Max Depth">
                          <p>
                            Optional recursion depth when Batshit indexes this project. Leave it blank to
                            use the system default depth.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="project-depth"
                        type="number"
                        min="0"
                        placeholder="10"
                        bind:value={projectForm.max_depth}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row is-spine-toggle">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Default Exclusions</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Default Exclusions">
                          <p>
                            Automatically skips common build output, caches, and other high-noise folders
                            so agent file access stays cleaner by default.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-inline-status">
                      <span class="batshit-settings-form-meta">{projectForm.use_default_exclusions ? 'Enabled' : 'Disabled'}</span>
                      <Switch.Root bind:checked={projectForm.use_default_exclusions} />
                    </div>
                  </div>
                </div>
	            </SettingsAccordionCard>

	            <SettingsAccordionCard
              name="projects-settings-cards"
              title="Project Rules"
              batshitIcon="rules"
              contentClass="space-y-4"
            >
              {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Project Rules" contentClass="w-80">
                    <p>
                      Additional exclusions filter files out of agent access. AI Rules are passed to
                      agents through DYNAMIC INFO whenever this project resolves as the active or default
                      project context.
                    </p>
                  </SettingsInfoMenu>
              {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <p class="batshit-settings-form-label">Custom Exclusions</p>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-compact-action">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => (projectCustomExclusionsEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <p class="batshit-settings-form-label">{getProjectRulesFieldLabel()}</p>
                        <SettingsInfoMenu ariaLabel="About Project Rules JSON" contentClass="w-80">
                          <p>
                            These rules are not hard-enforced by Batshit. They are passed into the AI
                            context as <code>project_rules_json</code> whenever this project is the
                            active or default project context.
                          </p>
                          <p class="mt-2">
                            Use this for stable repo guidance like preferred language, framework,
                            package manager, file conventions, or test commands.
                          </p>
                          <p class="mt-2">
                            Use Root Path and Exclusions for real safety boundaries.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-compact-action">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => (projectRulesEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>
                </div>

                {#if validationError}
                  <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
                    <AlertCircle class="h-4 w-4" />
                    {validationError}
                  </div>
                {/if}
            </SettingsAccordionCard>

              {#if projectForm.use_default_exclusions}
                <SettingsAccordionCard
                  name="projects-settings-cards"
                  title="Default Exclusions for Safety (Recommended)"
                  icon={Shield}
                  contentClass="batshit-settings-card-caption grid grid-cols-2 gap-2 sm:grid-cols-3"
                >
                  {#snippet info()}
                      <SettingsInfoMenu ariaLabel="About Default Exclusions for Safety">
                        <p>
                          These are the common heavy and noisy folders Batshit skips automatically
                          when <span class="batshit-settings-inline-strong">Default Exclusions</span> is enabled in
                          <span class="batshit-settings-inline-strong"> Project Settings</span>.
                        </p>
                        <p class="mt-2">
                          This list is separate from the always-blocked secrets and credentials list
                          below.
                        </p>
                      </SettingsInfoMenu>
                  {/snippet}
                    {#each DEFAULT_EXCLUSIONS as pattern}
                      <code class="rounded bg-background px-2 py-1">{pattern}</code>
                    {/each}
                </SettingsAccordionCard>
              {/if}

            <SettingsAccordionCard
              name="projects-settings-cards"
              title="Always Excluded for Safety"
              icon={Shield}
              contentClass="batshit-settings-card-caption grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Always Excluded for Safety">
                    <p>
                      Batshit automatically blocks secrets, credentials, and SSH keys so agents never
                      see them, even if the project points at a sensitive repo.
                    </p>
                  </SettingsInfoMenu>
              {/snippet}
                {#each SECURITY_EXCLUSIONS as pattern}
                  <code class="rounded bg-background px-2 py-1">{pattern}</code>
                {/each}
            </SettingsAccordionCard>

            <Collapsible.Root bind:open={deleteDisclosureOpen}>
              <div>
                <Collapsible.Trigger class="batshit-settings-delete-trigger">
                  <span class="batshit-settings-delete-trigger-label">
                    <Trash2 class="batshit-settings-delete-trigger-icon" />
                    Delete Project
                  </span>
                  <ChevronDown
                    class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                  />
                </Collapsible.Trigger>
                <Collapsible.Content class="batshit-settings-delete-content">
                  <div class="batshit-settings-delete-content-inner">
                    <div class="batshit-settings-delete-copy">
                      <p>Permanently removes this project and its project-specific AI rules.</p>
                      <p>Use this when the project boundary is obsolete or needs to be rebuilt cleanly.</p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      class="batshit-settings-delete-action"
                      onclick={handleDeleteProject}
                      disabled={deleteBusy}
                    >
                      {#if deleteBusy}
                        <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                      {:else}
                        <Trash2 class="batshit-settings-delete-action-icon" />
                      {/if}
                      Delete Project
                    </Button>
                  </div>
                </Collapsible.Content>
              </div>
            </Collapsible.Root>
	          {/if}
	        </div>
	      </div>
	    </div>
    </div>
	  </div>
{/if}

<SettingsTextEditor
  bind:open={createCustomExclusionsEditorOpen}
  title="Custom Exclusions"
  description="Add one custom glob pattern per line for this project."
  value={createForm.custom_exclusions}
  placeholder={`**/generated/**
**/vendor/**
**/*.tmp`}
  width="large"
  saveLabel="Save Exclusions"
  onSave={saveCreateCustomExclusionsFromEditor}
/>

<SettingsTextEditor
  bind:open={createRulesEditorOpen}
  title={getProjectRulesFieldLabel()}
  description="Structured project guidance Batshit passes into AI context as project_rules_json."
  value={createForm.rules_json}
  placeholder={`{
  "preferred_language": "TypeScript"
}`}
  width="large"
  saveLabel="Save Rules"
  onSave={saveCreateRulesFromEditor}
/>

<SettingsTextEditor
  bind:open={projectCustomExclusionsEditorOpen}
  title="Custom Exclusions"
  description="Add one custom glob pattern per line for this project."
  value={projectForm.custom_exclusions}
  placeholder={`**/generated/**
**/vendor/**
**/*.tmp`}
  width="large"
  saveLabel="Save Exclusions"
  onSave={saveProjectCustomExclusionsFromEditor}
/>

<SettingsTextEditor
  bind:open={projectRulesEditorOpen}
  title={getProjectRulesFieldLabel()}
  description="Structured project guidance Batshit passes into AI context as project_rules_json."
  value={projectForm.rules_json}
  placeholder={`{
  "preferred_language": "TypeScript"
}`}
  width="large"
  saveLabel="Save Rules"
  onSave={saveProjectRulesFromEditor}
/>
