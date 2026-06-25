<script lang="ts">
  import { RefreshCw, Search, Settings } from '@lucide/svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { Input } from '$lib/components/ui/input'
  import * as projectStore from '$lib/stores/projects.svelte'
  import ProjectSelector from './ProjectSelector.svelte'
  import FileTree from './FileTree.svelte'
  import ProjectQuickViewDialog from './ProjectQuickViewDialog.svelte'
  import { onMount } from 'svelte'
  import { FileTreeService } from '$lib/services/fileTree'
  import { loadProjectTree, refreshProjectTree } from '$lib/projects/fileTreeActions'
  import { ProjectService } from '$lib/services/projects'
  import { toast } from 'svelte-sonner'
  import { artifactService } from '$lib/services/artifactService'
  import { marked } from 'marked'
  import type { Project } from '$lib/stores/projects.svelte'
  
  let {
    data,
    isTokenPanelOpen = false,
    rightPanelOpen = false,
    rightPanelMinWidth = 480,
    chatMinWidth = 480,
    rightRailWidth = 48
  } = $props<{
    data: any
    isTokenPanelOpen?: boolean
    rightPanelOpen?: boolean
    rightPanelMinWidth?: number
    chatMinWidth?: number
    rightRailWidth?: number
  }>()
  
  // Min/max constraints for Projects sidebar
  const MIN_WIDTH = 175
  const MAX_WIDTH = 350
  const DEFAULT_WIDTH = 250
  
  let isCollapsed = $state(true)
  let sidebarWidth = $state(DEFAULT_WIDTH)
  let isDragging = $state(false)
  let viewportWidth = $state(0)
  let rightPanelTemporaryCollapsed = $state(false)
  let collapsedBeforeRightPanel: boolean | null = null
  
  const projects = $derived(projectStore.getProjects())
  const currentProject = $derived(projectStore.getCurrentProject())
  const fileTree = $derived(projectStore.getFileTree())
  const flatFiles = $derived(projectStore.getFlatFileList())
  const loading = $derived(projectStore.isLoading())
  const loadingStatus = $derived(projectStore.getLoadingStatus())
  const error = $derived(projectStore.getError())
  const fileTreeLoadedAt = $derived(projectStore.getFileTreeLoadedAt())
  const fileTreeStale = $derived(projectStore.isFileTreeStale())
  const mentionIndexStatus = $derived(projectStore.getMentionIndexStatus())
  const mentionIndexError = $derived(projectStore.getMentionIndexError())
  const mentionIndexTruncated = $derived(projectStore.isMentionIndexTruncated())

  let quickViewOpen = $state(false)
  let quickViewPath = $state('')
  let quickViewContent = $state('')
  let quickViewLoading = $state(false)
  let quickViewError = $state<string | null>(null)
  let quickViewSize = $state<number | null>(null)
  let quickViewMtime = $state<string | null>(null)
  let quickViewLanguage = $state('text')
  let quickViewTooLarge = $state(false)
  let quickViewLineNumber = $state<number | null>(null)
  const QUICK_VIEW_LIMIT = 256 * 1024
  const STALE_AFTER_MS = 1000 * 60 * 5
  const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//
  let fileSearch = $state('')
  
  // Lazy tree loads: first open fetches only the root level; refresh re-fetches
  // the root plus previously expanded directories. Both kick the background
  // @ mention index walk (see $lib/projects/fileTreeActions).
  async function loadCurrentProjectFileTree(
    forceLoad = false,
    options: { notify?: boolean } = {}
  ) {
    const project = currentProject
    if (!project) return
    if (projectStore.hasProjectBeenLoaded(project.id)) {
      if (forceLoad) {
        await refreshProjectTree(project, options)
      }
    } else {
      await loadProjectTree(project, options)
    }
  }

  function resolveFileEntry(path: string) {
    return flatFiles.find((file) => file.path === path)
  }

  function normalizeLocalPath(path: string) {
    return path.trim().replace(/\\/g, '/')
  }

  function trimTrailingSlash(path: string) {
    const normalized = normalizeLocalPath(path)
    if (normalized.length <= 1) return normalized
    return normalized.replace(/\/+$/, '')
  }

  function isAbsoluteLocalPath(path: string) {
    const normalized = normalizeLocalPath(path)
    return normalized.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(normalized)
  }

  function absolutePathBelongsToRoot(filePath: string, rootPath: string) {
    const normalizedFile = normalizeLocalPath(filePath)
    const normalizedRoot = trimTrailingSlash(rootPath)
    return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)
  }

  function relativePathFromRoot(filePath: string, rootPath: string) {
    const normalizedFile = normalizeLocalPath(filePath)
    const normalizedRoot = trimTrailingSlash(rootPath)
    if (normalizedFile === normalizedRoot) return ''
    return normalizedFile.slice(normalizedRoot.length + 1)
  }

  async function ensureProjectsAvailable() {
    const existing = projectStore.getProjects()
    if (existing.length > 0 || !data?.user?.id) return existing

    const service = new ProjectService()
    const loadedProjects = await service.loadProjects(data.user.id)
    if (loadedProjects.length > 0) {
      projectStore.setProjects(loadedProjects)
    }
    return loadedProjects
  }

  function resolveQuickViewTarget(rawPath: string, availableProjects: Project[]) {
    const path = normalizeLocalPath(rawPath)
    if (!path) return null

    const activeProject = projectStore.getCurrentProject()
    if (isAbsoluteLocalPath(path)) {
      const matchingProjects = [...availableProjects].sort(
        (left, right) => trimTrailingSlash(right.root_path).length - trimTrailingSlash(left.root_path).length
      )
      const project = matchingProjects.find((candidate) =>
        absolutePathBelongsToRoot(path, candidate.root_path)
      )
      if (!project) return null
      const relativePath = relativePathFromRoot(path, project.root_path)
      return relativePath ? { project, filePath: relativePath } : null
    }

    const project = activeProject ?? availableProjects[0] ?? null
    return project ? { project, filePath: path } : null
  }

  function formatScanTime(value?: number | null) {
    if (!value) return 'Never'
    try {
      return new Date(value).toLocaleTimeString()
    } catch {
      return 'Unknown'
    }
  }

  function isScanStale() {
    if (!fileTreeLoadedAt) return true
    if (fileTreeStale) return true
    return Date.now() - fileTreeLoadedAt > STALE_AFTER_MS
  }

  const SEARCH_RESULT_CAP = 400

  // Fallback search over the lazily loaded tree (root + expanded directories).
  function filterLoadedTree(nodes: typeof fileTree, query: string) {
    if (!query) return nodes
    const lowered = query.toLowerCase()
    const results: typeof fileTree = []

    for (const node of nodes) {
      const matches =
        node.name.toLowerCase().includes(lowered) ||
        node.path.toLowerCase().includes(lowered)

      if (node.type === 'directory' && node.children) {
        const children = filterLoadedTree(node.children, query)
        if (children.length > 0 || matches) {
          results.push({
            ...node,
            children,
            isExpanded: true
          })
        }
      } else if (matches) {
        results.push(node)
      }
    }

    return results
  }

  function markSearchTreeExpanded(nodes: typeof fileTree): typeof fileTree {
    return nodes.map((node) =>
      node.type === 'directory' && node.children
        ? { ...node, isExpanded: true, children: markSearchTreeExpanded(node.children) }
        : node
    )
  }

  interface FileSearchResult {
    tree: typeof fileTree
    capped: boolean
    usingIndex: boolean
  }

  // Search prefers the background @ mention index (whole project) and falls
  // back to the loaded tree levels while the index is still hydrating.
  const fileSearchResult = $derived.by<FileSearchResult | null>(() => {
    const query = fileSearch.trim().toLowerCase()
    if (!query) return null

    if (flatFiles.length > 0) {
      const matches: typeof flatFiles = []
      for (const entry of flatFiles) {
        if (
          entry.name.toLowerCase().includes(query) ||
          entry.path.toLowerCase().includes(query)
        ) {
          matches.push(entry)
          if (matches.length >= SEARCH_RESULT_CAP) break
        }
      }
      return {
        tree: markSearchTreeExpanded(FileTreeService.buildTreeFromEntries(matches)),
        capped: matches.length >= SEARCH_RESULT_CAP,
        usingIndex: true
      }
    }

    return {
      tree: filterLoadedTree(fileTree, fileSearch.trim()),
      capped: false,
      usingIndex: false
    }
  })

  const filteredFileTree = $derived.by(() => (fileSearchResult ? fileSearchResult.tree : fileTree))

  function openProjectsSettings(mode: 'list' | 'create' = 'list') {
    window.dispatchEvent(
      new CustomEvent('batshit:open-settings', {
        detail: { tab: 'projects', mode }
      })
    )
  }

  function normalizeQuickViewLineNumber(value: unknown) {
    const lineNumber =
      typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
    return Number.isFinite(lineNumber) && lineNumber > 0 ? lineNumber : null
  }

  async function openQuickView(path: string, options: { lineNumber?: unknown } = {}) {
    let availableProjects: Project[]
    try {
      availableProjects = await ensureProjectsAvailable()
    } catch (error) {
      console.error('Failed to load projects for Quick View:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load projects')
      return
    }
    const target = resolveQuickViewTarget(path, availableProjects)
    if (!target) {
      toast.error(
        isAbsoluteLocalPath(path)
          ? 'That file is outside your configured projects'
          : 'Select a project first'
      )
      return
    }

    const previousProjectId = projectStore.getCurrentProjectId()
    if (previousProjectId !== target.project.id) {
      projectStore.setCurrentProject(target.project.id)
    }

    projectStore.setActiveFile(target.filePath)
    const entry = previousProjectId === target.project.id ? resolveFileEntry(target.filePath) : undefined
    quickViewPath = target.filePath
    quickViewSize = entry?.size ?? null
    quickViewMtime = entry?.mtime ?? null
    const extension = entry?.extension || target.filePath.split('.').pop() || 'text'
    quickViewLanguage = extension
    quickViewError = null
    quickViewContent = ''
    quickViewLineNumber = normalizeQuickViewLineNumber(options.lineNumber)
    const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'zip', 'gz', 'tar']
    const isBinary = binaryExtensions.includes(extension)
    quickViewTooLarge = Boolean(isBinary || (entry?.size && entry.size > QUICK_VIEW_LIMIT))
    quickViewOpen = true

    if (quickViewTooLarge) {
      return
    }

    quickViewLoading = true
    try {
      const content = await FileTreeService.readFile(target.filePath, target.project.root_path)
      quickViewContent = content
    } catch (error) {
      quickViewError = 'Failed to read file'
    } finally {
      quickViewLoading = false
    }
  }

  async function openInArtifacts(path: string) {
    if (!currentProject || !data?.user) {
      toast.error('Select a project first')
      return
    }
    const entry = resolveFileEntry(path)
    try {
      const content = await FileTreeService.readFile(path, currentProject.root_path)
      const extension = entry?.extension || path.split('.').pop() || 'html'
      const isMarkdown = extension === 'md' || extension === 'markdown'
      const htmlContent = isMarkdown
        ? `<!doctype html><html><head><meta charset=\"utf-8\" /><style>body{font-family:var(--batshit-font,system-ui);padding:20px;line-height:1.55}pre{white-space:pre-wrap}</style></head><body>${marked.parse(content)}</body></html>`
        : content

      const artifact = await artifactService.createArtifact({
        name: `${entry?.name || path}`,
        type: 'html',
        content: htmlContent,
        mode: 'edit'
      })

      window.dispatchEvent(
        new CustomEvent('batshit:artifact-open', {
          detail: { artifactId: artifact.id }
        })
      )
      toast.success('Opened in Artifacts')
    } catch (error) {
      console.error('Failed to open in Artifacts', error)
      toast.error('Failed to open in Artifacts')
    }
  }

  async function handleRefreshClick() {
    if (!currentProject) return
    await loadCurrentProjectFileTree(true, { notify: true })
  }
  
  function toggleSidebar() {
    isCollapsed = !isCollapsed
    rightPanelTemporaryCollapsed = false
    collapsedBeforeRightPanel = null
    
    // Save collapsed state
    localStorage.setItem('projectsSidebarCollapsed', String(isCollapsed))
    
    // Load file tree on first open or when stale
    if (!isCollapsed && currentProject) {
      if (!projectStore.hasProjectBeenLoaded(currentProject.id) || isScanStale()) {
        loadCurrentProjectFileTree(true)
      }
    }
  }

  function needsProjectWidthForRightPanel() {
    if (!rightPanelOpen) return false
    const width = viewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 0)
    if (!width) return false
    return width < sidebarWidth + chatMinWidth + rightPanelMinWidth + rightRailWidth
  }

  $effect(() => {
    if (!rightPanelOpen) {
      if (rightPanelTemporaryCollapsed && collapsedBeforeRightPanel !== null) {
        isCollapsed = collapsedBeforeRightPanel
      }
      rightPanelTemporaryCollapsed = false
      collapsedBeforeRightPanel = null
      return
    }

    const shouldTemporarilyCollapse = needsProjectWidthForRightPanel()
    if (!isCollapsed && shouldTemporarilyCollapse) {
      if (collapsedBeforeRightPanel === null) collapsedBeforeRightPanel = isCollapsed
      isCollapsed = true
      rightPanelTemporaryCollapsed = true
      return
    }

    if (
      rightPanelTemporaryCollapsed &&
      collapsedBeforeRightPanel === false &&
      !shouldTemporarilyCollapse
    ) {
      isCollapsed = false
      rightPanelTemporaryCollapsed = false
      collapsedBeforeRightPanel = null
    }
  })
  
  // Drag handler for resizing
  export function handleDragStart(e: MouseEvent) {
    e.preventDefault()
    isDragging = true
    const startX = e.clientX
    const startWidth = sidebarWidth
    
    function handleMouseMove(e: MouseEvent) {
      if (!isDragging) return
      const deltaX = e.clientX - startX
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + deltaX))
      sidebarWidth = newWidth
    }
    
    function handleMouseUp() {
      isDragging = false
      localStorage.setItem('projectsSidebarWidth', String(sidebarWidth))
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
    
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }
  
  // Listen for project creation events and restore saved state
  onMount(() => {
    const updateViewportWidth = () => {
      viewportWidth = window.innerWidth
    }
    updateViewportWidth()
    window.addEventListener('resize', updateViewportWidth)

    // Restore saved width and collapsed state
    const savedWidth = localStorage.getItem('projectsSidebarWidth')
    if (savedWidth) {
      const width = parseInt(savedWidth)
      if (!isNaN(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) {
        sidebarWidth = width
      }
    }
    
    const savedCollapsedStr = localStorage.getItem('projectsSidebarCollapsed')
    if (savedCollapsedStr !== null) {
      isCollapsed = savedCollapsedStr === 'true'
    }
    
    const handleProjectCreated = async (event: Event) => {
      const customEvent = event as CustomEvent;
      // If sidebar is open, load the new project's file tree
      if (!isCollapsed) {
        const project = projectStore.getProjects().find(p => p.id === customEvent.detail.projectId)
        if (project) {
          await loadCurrentProjectFileTree(true) // Force load for new project
        }
      }
    }
    
    window.addEventListener('project-created', handleProjectCreated)

    const handleQuickViewEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; lineNumber?: unknown }
      if (!detail?.path) return
      openQuickView(detail.path, { lineNumber: detail.lineNumber })
    }

    const handleOpenArtifactEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string }
      if (!detail?.path) return
      openInArtifacts(detail.path)
    }

    const handleWindowFocus = () => {
      if (!isCollapsed && currentProject && !loading && isScanStale()) {
        loadCurrentProjectFileTree(true)
      }
    }

    window.addEventListener('batshit:project-quick-view', handleQuickViewEvent as EventListener)
    window.addEventListener('batshit:project-open-artifact', handleOpenArtifactEvent as EventListener)
    window.addEventListener('focus', handleWindowFocus)
    
    return () => {
      window.removeEventListener('resize', updateViewportWidth)
      window.removeEventListener('project-created', handleProjectCreated)
      window.removeEventListener('batshit:project-quick-view', handleQuickViewEvent as EventListener)
      window.removeEventListener('batshit:project-open-artifact', handleOpenArtifactEvent as EventListener)
      window.removeEventListener('focus', handleWindowFocus)
    }
  })
</script>

<!-- Container for sidebar and tab -->
<div class="projects-sidebar-container">
  <!-- Main sidebar -->
  <div
  class={`projects-sidebar ${isCollapsed ? '' : 'is-open'}`}
  style={`width: ${isCollapsed ? '0' : sidebarWidth + 'px'}`}
  >
    {#if !isCollapsed}
      <!-- Expanded state -->
      <div class="projects-sidebar-inner">
        <!-- Project selector -->
        <div class="projects-sidebar-header">
          <div class="projects-sidebar-toolbar">
            <div class="projects-sidebar-selector">
              <ProjectSelector {data} />
            </div>
            <button
              class="projects-sidebar-action-button"
              onclick={() => openProjectsSettings('list')}
              aria-label="Manage projects"
              title="Manage Projects"
              data-testid="manage-projects-button"
              data-ab-control="manage-projects"
            >
              <Settings class="projects-sidebar-action-icon" />
            </button>
            <button
              class="projects-sidebar-action-button"
              onclick={handleRefreshClick}
              aria-label="Refresh file tree"
              title="Refresh file tree"
              disabled={loading}
              data-testid="refresh-file-tree-button"
              data-ab-control="refresh-file-tree"
            >
              <RefreshCw class={`projects-sidebar-action-icon ${loading ? 'is-spinning' : ''}`} />
            </button>
          </div>
          <div class="projects-sidebar-search">
            <Search class="projects-sidebar-search-icon" />
            <Input
              class="projects-sidebar-search-input"
              placeholder="Filter files..."
              aria-label="Filter project files"
              title="Filter project files"
              bind:value={fileSearch}
            />
          </div>
        </div>
      
        <div class="projects-sidebar-body">
          <!-- File tree area with smaller font for better fit -->
          <div class="projects-sidebar-tree-scroll">
            {#if currentProject}
              {#if fileTree.length > 0}
                {#if filteredFileTree.length > 0}
                  <FileTree nodes={filteredFileTree} />
                  {#if fileSearchResult?.capped}
                    <div class="projects-sidebar-state">
                      Showing the first {SEARCH_RESULT_CAP} matches — keep typing to narrow
                    </div>
                  {/if}
                  {#if fileSearchResult && !fileSearchResult.usingIndex && mentionIndexStatus !== 'ready'}
                    <div class="projects-sidebar-state">
                      File index still building — searching loaded folders only
                    </div>
                  {/if}
                {:else}
                  <div class="projects-sidebar-state">
                    No files match “{fileSearch}”
                  </div>
                {/if}
                <div class="projects-sidebar-status">
                  <div>
                    Folders load on expand • {currentProject.custom_exclusions?.length || 0} custom exclusions
                  </div>
                  <div>
                    Last scan: {formatScanTime(fileTreeLoadedAt)}{fileTreeStale ? ' • stale' : ''}{loading ? ' • refreshing' : ''}
                  </div>
                  {#if mentionIndexStatus === 'loading'}
                    <div class="projects-sidebar-pulse">
                      Indexing files for @ mentions...
                    </div>
                  {:else if mentionIndexStatus === 'error'}
                    <div class="projects-sidebar-status-error" title={mentionIndexError}>
                      @ mention index failed — autocomplete limited
                    </div>
                  {:else if mentionIndexStatus === 'ready'}
                    <div>
                      {flatFiles.length.toLocaleString()} files indexed for @ mentions{mentionIndexTruncated ? ' (truncated — add exclusions to narrow the scan)' : ''}
                    </div>
                  {/if}
                  {#if loading}
                    <div class="projects-sidebar-pulse">
                      {loadingStatus || 'Refreshing file tree...'}
                    </div>
                  {/if}
                </div>
              {:else if loading}
                <div class="projects-sidebar-state-stack">
                  <div class="projects-sidebar-pulse">
                    {loadingStatus || 'Loading project files...'}
                  </div>
                  <div class="projects-sidebar-state">
                    Excluding: node_modules, dist, .git, etc.
                  </div>
                </div>
              {:else if error}
                <div class="projects-sidebar-state-stack">
                  <div class="projects-sidebar-state is-error">
                    {error}
                  </div>
                  {#if error.includes('Batshit-Server')}
                    <div class="projects-sidebar-state">
                      Check that this project path exists from Batshit's current runtime. Docker installs usually use <code class="projects-sidebar-code">/workspace</code>.
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="projects-sidebar-state">
                  No files found in project
                </div>
              {/if}
            {:else}
              <div class="projects-sidebar-state is-centered">
                Select a project to view files
              </div>
            {/if}
          </div>

        </div>
      </div>
    {/if}
  </div>
  
  <!-- Tab-style toggle button with drag handle -->
  <div
    class="projects-sidebar-tab"
    style="right: -{isCollapsed ? '31px' : '48px'}; top: {isTokenPanelOpen ? '115px' : '14px'};"
  >
    <!-- Toggle button -->
    <button
      onclick={toggleSidebar}
      class="projects-sidebar-tab-button"
      aria-label={isCollapsed ? 'Open projects sidebar' : 'Collapse projects sidebar'}
      title={isCollapsed ? 'Open projects sidebar' : 'Collapse projects sidebar'}
      data-testid="projects-sidebar-toggle"
      data-ab-control="projects-sidebar-toggle"
    >
      <BatshitIcon id="projects" class="projects-sidebar-tab-icon" />
      <span class="projects-sidebar-screen-reader">{isCollapsed ? 'Open projects sidebar' : 'Collapse projects sidebar'}</span>
    </button>
    
    <!-- Drag handle (only visible when open) -->
    {#if !isCollapsed}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize projects sidebar"
        tabindex="0"
        class="projects-sidebar-tab-resize"
        onmousedown={handleDragStart}
        onkeydown={(e) => {
          // Handle keyboard resize with arrow keys
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            // Could implement keyboard resize here if needed
          }
        }}
      >
        <!-- Visible grip dots -->
        <div class="projects-sidebar-tab-grip">
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
    {/if}
  </div>
</div>

<ProjectQuickViewDialog
  bind:open={quickViewOpen}
  path={quickViewPath}
  content={quickViewContent}
  loading={quickViewLoading}
  error={quickViewError}
  size={quickViewSize}
  mtime={quickViewMtime}
  language={quickViewLanguage}
  tooLarge={quickViewTooLarge}
  targetLineNumber={quickViewLineNumber}
  previewLimitBytes={QUICK_VIEW_LIMIT}
/>

<style>
  .projects-sidebar-container {
    position: relative;
    height: 100%;
    overflow: visible;
  }

  .projects-sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--background);
    color: var(--bs-app-text);
    transition: width 300ms ease-out;
  }

  .projects-sidebar.is-open {
    border-right: 1px solid var(--bs-app-inner-line);
  }

  .projects-sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .projects-sidebar-header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid var(--bs-app-inner-line);
  }

  .projects-sidebar-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .projects-sidebar-selector {
    flex: 1 1 auto;
    min-width: 0;
  }

  .projects-sidebar-action-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    cursor: pointer;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      opacity 150ms ease-out;
  }

  .projects-sidebar-action-button:hover:not(:disabled) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .projects-sidebar-action-button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  :global(.projects-sidebar-action-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.projects-sidebar-action-icon.is-spinning) {
    animation: projects-spin 1s linear infinite;
  }

  .projects-sidebar-search {
    position: relative;
  }

  :global(.projects-sidebar-search-icon) {
    position: absolute;
    top: 10px;
    left: 8px;
    width: 12px;
    height: 12px;
    color: var(--bs-app-muted-text);
    pointer-events: none;
  }

  :global(.projects-sidebar-search-input) {
    height: 32px;
    padding-left: 28px;
    font-size: 0.75rem;
  }

  .projects-sidebar-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }

  .projects-sidebar-tree-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    font-size: 0.75rem;
  }

  .projects-sidebar-state,
  .projects-sidebar-status {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .projects-sidebar-state {
    padding: 1rem;
  }

  .projects-sidebar-state.is-centered {
    text-align: center;
  }

  .projects-sidebar-state.is-error {
    color: var(--destructive);
    font-weight: 500;
  }

  .projects-sidebar-status-error {
    color: var(--destructive);
  }

  .projects-sidebar-state-stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
  }

  .projects-sidebar-status {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--bs-app-inner-line);
  }

  .projects-sidebar-pulse {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
    animation: projects-pulse 1.4s ease-in-out infinite;
  }

  .projects-sidebar-code {
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    background: var(--bs-app-field);
  }

  .projects-sidebar-screen-reader {
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

  .projects-sidebar-tab {
    position: absolute;
    z-index: var(--z-surface);
    display: flex;
    align-items: center;
    overflow: hidden;
    border-width: 1px 1px 1px 0;
    border-style: solid;
    border-color: var(--bs-app-shell-line);
    border-radius: 0 6px 6px 0;
    background: var(--background);
    transition:
      top 200ms ease-out,
      right 200ms ease-out,
      background-color 150ms ease-out,
      border-color 150ms ease-out;
  }

  .projects-sidebar-tab-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;
  }

  .projects-sidebar-tab-button:hover,
  .projects-sidebar-tab-button:focus-visible,
  .projects-sidebar-tab-resize:hover,
  .projects-sidebar-tab-resize:focus-visible {
    background: var(--bs-app-inset-surface-hover);
    color: var(--bs-app-title);
    outline: none;
  }

  :global(.projects-sidebar-tab-icon) {
    width: 16px;
    height: 16px;
  }

  .projects-sidebar-tab-resize {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 32px;
    border: 0;
    background: transparent;
    cursor: col-resize;
    color: var(--bs-app-muted-text);
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;
  }

  .projects-sidebar-tab-grip {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
  }

  .projects-sidebar-tab-grip div {
    width: 2px;
    height: 2px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--bs-app-muted-text) 60%, transparent);
  }

  @keyframes projects-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes projects-pulse {
    50% {
      opacity: 0.45;
    }
  }
</style>
