<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import PrismCodeBlock from '$lib/components/renderers/shared/PrismCodeBlock.svelte'
  import { estimateTokens, formatTokenCount } from '$lib/utils/tokens'

  interface Props {
    open: boolean
    path: string
    content: string
    loading: boolean
    error: string | null
    size: number | null
    mtime: string | null
    language: string
    tooLarge: boolean
    targetLineNumber?: number | null
    previewLimitBytes: number
  }

  let {
    open = $bindable(false),
    path,
    content,
    loading,
    error,
    size,
    mtime,
    language,
    tooLarge,
    targetLineNumber = null,
    previewLimitBytes
  }: Props = $props()

  function formatFileSize(value?: number | null) {
    if (!value && value !== 0) return ''
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  function formatMtime(value?: string | null) {
    if (!value) return ''
    try {
      return new Date(value).toLocaleString()
    } catch {
      return value || ''
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="projects-quick-view-dialog">
    <Dialog.Header>
      <Dialog.Title>Quick View</Dialog.Title>
      <Dialog.Description class="projects-quick-view-path">{path}</Dialog.Description>
    </Dialog.Header>
    <div class="projects-quick-view-body">
      <div class="projects-quick-view-meta">
        {#if size !== null}
          <span>Size: {formatFileSize(size)}</span>
        {/if}
        {#if mtime}
          <span>Modified: {formatMtime(mtime)}</span>
        {/if}
        {#if content}
          <span>Tokens: {formatTokenCount(estimateTokens(content))}</span>
        {/if}
      </div>

      {#if loading}
        <div class="projects-quick-view-note">Loading file...</div>
      {:else if error}
        <div class="projects-quick-view-note is-error">{error}</div>
      {:else if tooLarge}
        <div class="projects-quick-view-note">
          File is binary or larger than {formatFileSize(previewLimitBytes)}.
        </div>
      {:else if content}
        <PrismCodeBlock {content} {language} {targetLineNumber} />
      {:else}
        <div class="projects-quick-view-note">No content available.</div>
      {/if}
    </div>
    <Dialog.Footer class="projects-quick-view-footer">
      <div class="projects-quick-view-note">
        {content
          ? `≈ ${formatTokenCount(estimateTokens(content))} tokens${targetLineNumber ? ` • line ${targetLineNumber}` : ''}`
          : ''}
      </div>
      <div class="projects-quick-view-actions">
        <Button onclick={() => (open = false)}>Close</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(.projects-quick-view-dialog) {
    display: flex;
    flex-direction: column;
    width: 90vw;
    max-width: 980px;
    max-height: min(86vh, calc(100vh - 2rem));
    overflow: hidden;
  }

  :global(.projects-quick-view-path) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .projects-quick-view-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    overflow: hidden;
    padding-right: 0.25rem;
  }

  .projects-quick-view-body :global(.prism-code-block) {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
  }

  .projects-quick-view-body :global(.prism-pre) {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .projects-quick-view-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .projects-quick-view-note {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .projects-quick-view-note.is-error {
    color: var(--destructive);
  }

  :global(.projects-quick-view-footer) {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .projects-quick-view-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
