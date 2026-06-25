<script lang="ts">
  import {
    AtSign,
    ChevronRight,
    ChevronDown,
    Copy,
    Eye,
    ExternalLink,
    Loader2,
    Upload
  } from '@lucide/svelte'
  import type { FileTreeNode } from '$lib/stores/projects.svelte'
  import * as projectStore from '$lib/stores/projects.svelte'
  import { expandDirectory } from '$lib/projects/fileTreeActions'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import FileTreeNodeComponent from './FileTreeNode.svelte'

  let { node, level = 0 } = $props<{ node: FileTreeNode; level?: number }>()

  const activeFilePath = $derived(projectStore.getActiveFilePath())
  const isActive = $derived(activeFilePath === node.path)
  const currentProject = $derived(projectStore.getCurrentProject())
  const isFile = $derived(node.type === 'file')
  const showEmptyState = $derived.by(() => {
    if (node.type !== 'directory' || !node.isExpanded) return false
    if (node.childrenLoading || node.childrenError) return false
    return node.childrenLoaded === true && (node.children?.length ?? 0) === 0
  })

  function handleClick() {
    if (node.type === 'directory') {
      if (node.isExpanded) {
        projectStore.setDirectoryExpanded(node.path, false)
      } else {
        void expandDirectory(node.path)
      }
    } else {
      projectStore.setActiveFile(node.path)
    }
  }

  function handleRetryLoad() {
    void expandDirectory(node.path)
  }

  function handleDragStart(event: DragEvent) {
    if (!isFile || !currentProject || !event.dataTransfer) return
    const payload = {
      projectId: currentProject.id,
      relativePath: node.path,
      mode: event.shiftKey ? 'mention' : 'upload'
    }
    event.dataTransfer.setData('application/x-batshit-project-file', JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', node.path)
    event.dataTransfer.effectAllowed = 'copy'
  }

  function dispatchMentionInsert() {
    window.dispatchEvent(
      new CustomEvent('batshit:insert-project-mention', {
        detail: { path: node.path }
      })
    )
  }

  function dispatchUpload() {
    window.dispatchEvent(
      new CustomEvent('batshit:upload-project-file', {
        detail: { path: node.path }
      })
    )
  }

  function dispatchQuickView() {
    window.dispatchEvent(
      new CustomEvent('batshit:project-quick-view', {
        detail: { path: node.path }
      })
    )
  }

  function dispatchOpenArtifact() {
    window.dispatchEvent(
      new CustomEvent('batshit:project-open-artifact', {
        detail: { path: node.path }
      })
    )
  }

  async function copyRelativePath() {
    try {
      await copyTextToClipboard(node.path)
    } catch (error) {
      console.error('Failed to copy path', error)
    }
  }

	async function copyFullPath() {
		if (!currentProject?.root_path) return
		const fullPath = `${currentProject.root_path.replace(/[\\/]+$/, '')}/${node.path}`
		try {
			await copyTextToClipboard(fullPath)
		} catch (error) {
			console.error('Failed to copy full path', error)
    }
  }

	const canOpenInArtifacts = $derived.by(() => {
		const ext = node.name.split('.').pop()?.toLowerCase()
		return ext === 'html' || ext === 'htm' || ext === 'md' || ext === 'markdown'
	})
  
  const treeIconRef = $derived(getProjectTreeIconRef(node))
</script>

<div>
  <ContextMenu.Root>
    <ContextMenu.Trigger
      onclick={handleClick}
      ondragstart={handleDragStart}
      draggable={isFile}
      class={`project-file-tree-node-trigger ${isActive ? 'is-active' : ''}`}
      style={`--file-tree-indent: ${8 + level * 12}px;`}
    >
      <!-- Chevron for directories (spinner while children load) -->
      {#if node.type === 'directory'}
        {#if node.childrenLoading}
          <Loader2 class="project-file-tree-chevron is-loading" />
        {:else if node.isExpanded}
          <ChevronDown class="project-file-tree-chevron" />
        {:else}
          <ChevronRight class="project-file-tree-chevron" />
        {/if}
      {:else}
        <!-- Spacer for files to align with directory names -->
        <div class="project-file-tree-chevron-spacer"></div>
      {/if}
      
      <!-- Icon -->
      <IconRenderer
        ref={treeIconRef}
        class={`project-file-tree-icon ${node.type === 'directory' ? 'is-directory' : 'is-file'}`}
        iconClass="project-file-tree-rendered-icon"
        label={node.name}
      />
      
      <!-- Name with tooltip on hover for long names -->
      <span class="project-file-tree-name" title={node.name}>{node.name}</span>
    </ContextMenu.Trigger>

    <ContextMenu.Content class="project-file-tree-menu">
      <ContextMenu.Label>{node.name}</ContextMenu.Label>
      <ContextMenu.Item onclick={dispatchMentionInsert}>
        <AtSign class="project-file-tree-menu-icon" />
        Insert @ mention
      </ContextMenu.Item>
      {#if isFile}
        <ContextMenu.Item onclick={dispatchUpload}>
          <Upload class="project-file-tree-menu-icon" />
          Upload to Clip Vault
        </ContextMenu.Item>
      {/if}
      <ContextMenu.Separator />
      <ContextMenu.Item onclick={copyRelativePath}>
        <Copy class="project-file-tree-menu-icon" />
        Copy relative path
      </ContextMenu.Item>
      <ContextMenu.Item onclick={copyFullPath}>
        <Copy class="project-file-tree-menu-icon" />
        Copy full path
      </ContextMenu.Item>
      {#if isFile}
        <ContextMenu.Separator />
        <ContextMenu.Item onclick={dispatchQuickView}>
          <Eye class="project-file-tree-menu-icon" />
          Quick view
        </ContextMenu.Item>
        {#if canOpenInArtifacts}
          <ContextMenu.Item onclick={dispatchOpenArtifact}>
            <ExternalLink class="project-file-tree-menu-icon" />
            Open in Artifacts
          </ContextMenu.Item>
        {/if}
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
  
  <!-- Children / per-directory states (if expanded directory) -->
  {#if node.type === 'directory' && node.isExpanded}
    {#if node.childrenError}
      <div
        class="project-file-tree-dir-state is-error"
        style={`--file-tree-indent: ${8 + (level + 1) * 12}px;`}
      >
        <span class="project-file-tree-dir-state-text" title={node.childrenError}>
          {node.childrenError}
        </span>
        <button
          type="button"
          class="project-file-tree-dir-retry"
          onclick={handleRetryLoad}
          disabled={node.childrenLoading}
        >
          Retry
        </button>
      </div>
    {:else if node.children}
      {#each node.children as child (child.path)}
        <FileTreeNodeComponent node={child} level={level + 1} />
      {/each}
      {#if showEmptyState}
        <div
          class="project-file-tree-dir-state"
          style={`--file-tree-indent: ${8 + (level + 1) * 12}px;`}
        >
          <span class="project-file-tree-dir-state-text">Empty folder</span>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  :global(.project-file-tree-node-trigger) {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0.125rem 0.5rem 0.125rem var(--file-tree-indent);
    border: 0;
    border-radius: 0.125rem;
    background: transparent;
    color: var(--foreground);
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
    transition: background-color 150ms ease-out;
  }

  :global(.project-file-tree-node-trigger:hover),
  :global(.project-file-tree-node-trigger.is-active) {
    background: var(--accent);
  }

  :global(.project-file-tree-chevron),
  .project-file-tree-chevron-spacer {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    margin-right: 0.25rem;
  }

  :global(.project-file-tree-icon),
  :global(.project-file-tree-rendered-icon) {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  :global(.project-file-tree-icon) {
    margin-right: 0.375rem;
  }

  :global(.project-file-tree-icon.is-directory) {
    color: #3b82f6;
  }

  :global(.project-file-tree-icon.is-file) {
    color: #6b7280;
  }

  .project-file-tree-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
  }

  :global(.project-file-tree-menu) {
    width: 14rem;
  }

  :global(.project-file-tree-menu-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.project-file-tree-chevron.is-loading) {
    animation: project-file-tree-spin 1s linear infinite;
  }

  .project-file-tree-dir-state {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem 0.125rem var(--file-tree-indent);
    color: var(--bs-app-muted-text);
    font-size: 0.7rem;
  }

  .project-file-tree-dir-state.is-error {
    color: var(--destructive);
  }

  .project-file-tree-dir-state-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-file-tree-dir-retry {
    flex-shrink: 0;
    padding: 0 0.375rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 0.25rem;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    font-size: 0.65rem;
    line-height: 1.4;
    cursor: pointer;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;
  }

  .project-file-tree-dir-retry:hover:not(:disabled) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .project-file-tree-dir-retry:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  @keyframes project-file-tree-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
