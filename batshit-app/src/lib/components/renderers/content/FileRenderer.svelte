<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import { Copy, Eye } from '@lucide/svelte'
  import PrismCodeBlock from '$lib/components/renderers/shared/PrismCodeBlock.svelte'
  import { estimateTokens, formatTokenCount } from '$lib/utils/tokens'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  
  let { 
    filename,
    url,
    size,
    type = 'application/octet-stream',
    tokens,
    content = ''
  } = $props<{ 
    filename: string
    url: string
    size?: number // bytes
    type?: string
    tokens?: number // estimated tokens
    content?: string
  }>()

  let previewOpen = $state(false)
  let previewContent = $state('')
  let previewLoading = $state(false)
  let previewError = $state<string | null>(null)
  let previewLoadedUrl = $state('')
  
  // Format file size or token estimate
  function formatFileSize(tokens?: number, bytes?: number): string {
    if (tokens !== undefined && tokens !== null) {
      return `≈ ${tokens.toLocaleString()} tokens`
    }
    if (!bytes) return 'Unknown size'
    const units = ['B', 'KB', 'MB', 'GB']
    let sizeVal = bytes
    let unitIndex = 0
    while (sizeVal >= 1024 && unitIndex < units.length - 1) {
      sizeVal /= 1024
      unitIndex++
    }
    return `${sizeVal.toFixed(1)} ${units[unitIndex]}`
  }
  
  function getIconFilename(name: string, mimeType?: string): string {
    const trimmedName = name || 'file'
    if (trimmedName.includes('.')) return trimmedName

    const normalizedMime = mimeType?.toLowerCase() || ''
    if (normalizedMime.includes('markdown')) return `${trimmedName}.md`
    if (normalizedMime.includes('json')) return `${trimmedName}.json`
    if (normalizedMime.includes('javascript')) return `${trimmedName}.js`
    if (normalizedMime.includes('typescript')) return `${trimmedName}.ts`
    if (normalizedMime.includes('shellscript') || normalizedMime.includes('x-sh')) return `${trimmedName}.sh`
    if (normalizedMime.startsWith('text/')) return `${trimmedName}.txt`
    return trimmedName
  }

  const fileIconRef = $derived(getProjectTreeIconRef({ name: getIconFilename(filename, type), type: 'file' }))
  const previewableText = $derived(isTextLikeFile(filename, type))
  const effectivePreviewContent = $derived(previewContent || usableInlineContent(content))
  const language = $derived(getLanguage(filename))
  const previewTokenLabel = $derived(
    effectivePreviewContent ? formatTokenCount(estimateTokens(effectivePreviewContent)) : ''
  )
  
  async function copyUrl() {
    if (!url) return
    try {
      await copyTextToClipboard(url)
    } catch (err) {
      console.error('Failed to copy URL:', err)
    }
  }

  function isTextLikeFile(name: string, mimeType?: string) {
    const normalizedMime = mimeType?.toLowerCase() || ''
    const extension = name.split('.').pop()?.toLowerCase() || ''
    if (
      normalizedMime.startsWith('text/') ||
      normalizedMime.includes('json') ||
      normalizedMime.includes('javascript') ||
      normalizedMime.includes('markdown') ||
      normalizedMime.includes('xml') ||
      normalizedMime.includes('yaml') ||
      normalizedMime.includes('x-shellscript')
    ) {
      return true
    }
    return /^(md|markdown|txt|sh|bash|zsh|js|jsx|ts|tsx|json|jsonl|yaml|yml|toml|css|scss|html|xml|py|rb|go|rs|java|c|cc|cpp|h|hpp|cs|sql|log|env)$/.test(extension)
  }

  function getLanguage(name: string) {
    const extension = name.split('.').pop()?.toLowerCase() || ''
    const languageMap: Record<string, string> = {
      bash: 'bash',
      css: 'css',
      env: 'bash',
      html: 'html',
      js: 'javascript',
      json: 'json',
      jsonl: 'json',
      jsx: 'jsx',
      md: 'markdown',
      markdown: 'markdown',
      py: 'python',
      sh: 'bash',
      svelte: 'svelte',
      ts: 'typescript',
      tsx: 'tsx',
      txt: 'text',
      yaml: 'yaml',
      yml: 'yaml',
      zsh: 'bash'
    }
    return languageMap[extension] || extension || 'text'
  }

  function usableInlineContent(value: string) {
    const trimmed = value?.trim() || ''
    if (!trimmed || trimmed === 'File attachment') return ''
    return trimmed
  }

  async function openQuickView() {
    previewOpen = true
    previewError = null

    if (usableInlineContent(content) || !previewableText || !url || previewLoadedUrl === url) {
      return
    }

    previewLoading = true
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error('Failed to load file preview')
      }
      previewContent = await response.text()
      previewLoadedUrl = url
    } catch (err) {
      previewError = err instanceof Error ? err.message : 'Failed to load file preview'
    } finally {
      previewLoading = false
    }
  }
</script>

<div
  class="file-renderer"
  role="button"
  tabindex="0"
  onclick={openQuickView}
  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openQuickView()}
  title={filename}
>
  <div class="file-icon">
    <IconRenderer
      ref={fileIconRef}
      label={filename}
      iconClass="file-renderer-file-type-icon"
      imageClass="file-renderer-file-type-icon"
    />
  </div>
  
  <div class="file-info">
    <div class="file-name">{filename}</div>
    <div class="file-meta">{formatFileSize(tokens, size)}</div>
  </div>
  
  <div class="file-actions">
    <Button
      variant="ghost"
      size="sm"
      onclick={(event) => {
        event.stopPropagation()
        void copyUrl()
      }}
      class="action-button"
      disabled={!url}
      title="Copy URL"
      aria-label={`Copy URL for ${filename}`}
    >
      <Copy class="h-4 w-4" />
    </Button>
    <Button
      variant="secondary"
      size="sm"
      onclick={(event) => {
        event.stopPropagation()
        void openQuickView()
      }}
      class="preview-button"
    >
      <Eye class="h-4 w-4" />
      Preview
    </Button>
  </div>
</div>

<Dialog.Root bind:open={previewOpen}>
  <Dialog.Content class="file-quick-view-dialog">
    <Dialog.Header>
      <Dialog.Title>Quick View</Dialog.Title>
      <Dialog.Description class="file-quick-view-path">{filename}</Dialog.Description>
    </Dialog.Header>

    <div class="file-quick-view-body">
      <div class="file-quick-view-meta">
        {#if size !== null && size !== undefined}
          <span>Size: {formatFileSize(undefined, size)}</span>
        {/if}
        {#if previewTokenLabel}
          <span>Tokens: {previewTokenLabel}</span>
        {:else if tokens}
          <span>{formatFileSize(tokens, undefined)}</span>
        {/if}
      </div>

      {#if previewLoading}
        <div class="file-quick-view-note">Loading file...</div>
      {:else if previewError}
        <div class="file-quick-view-note is-error">{previewError}</div>
      {:else if effectivePreviewContent}
        <PrismCodeBlock content={effectivePreviewContent} {language} />
      {:else}
        <div class="file-quick-view-note">No inline preview is available for this file.</div>
      {/if}
    </div>

    <Dialog.Footer class="file-quick-view-footer">
      <div class="file-quick-view-note">
        {previewTokenLabel ? `~ ${previewTokenLabel} tokens` : ''}
      </div>
      <Button onclick={() => (previewOpen = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .file-renderer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.85rem;
    margin: 0.5rem 0;
    background: var(--muted);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    transition: all 0.2s ease;
  }
  
  .file-renderer:hover {
    background: var(--muted-hover, var(--muted));
    border-color: var(--primary);
    cursor: pointer;
  }

  .file-renderer:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  
  .file-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(circle at 50% 35%, oklch(0.31 0.075 298 / 0.9), oklch(0.15 0.032 286) 74%),
      oklch(0.15 0.032 286);
    border: 1px solid oklch(0.62 0.15 303 / 0.7);
    border-radius: 0.6rem;
    color: var(--muted-foreground);
    box-shadow: 0 0 0 2px oklch(0.56 0.16 304 / 0.2);
  }

  :global(.file-renderer-file-type-icon) {
    width: 24px;
    height: 24px;
  }
  
  .file-info {
    flex: 1;
    min-width: 0;
  }
  
  .file-name {
    font-weight: 500;
    color: var(--foreground);
    word-break: break-word;
    line-height: 1.3;
    font-size: 0.95rem;
  }
  
  .file-meta {
    margin-top: 0.15rem;
    font-size: 0.85rem;
    color: var(--muted-foreground);
  }
  
  .file-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  
  :global(.file-actions .action-button) {
    width: 36px;
    padding: 0;
  }
  
  :global(.file-actions .preview-button) {
    gap: 0.5rem;
  }
  
  /* Responsive */
  @media (max-width: 640px) {
    .file-renderer {
      flex-wrap: wrap;
    }
    
    .file-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }

  :global(.file-quick-view-dialog) {
    display: flex;
    flex-direction: column;
    width: 90vw;
    max-width: 980px;
    max-height: min(86vh, calc(100vh - 2rem));
    overflow: hidden;
  }

  :global(.file-quick-view-path) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-quick-view-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    overflow: hidden;
    padding-right: 0.25rem;
  }

  .file-quick-view-body :global(.prism-code-block) {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
  }

  .file-quick-view-body :global(.prism-pre) {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .file-quick-view-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .file-quick-view-note {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .file-quick-view-note.is-error {
    color: var(--destructive);
  }

  :global(.file-quick-view-footer) {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
</style>
