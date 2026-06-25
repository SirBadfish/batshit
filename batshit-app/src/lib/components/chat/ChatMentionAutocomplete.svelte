<script lang="ts">
  import type { FlatFileEntry } from '$lib/stores/projects.svelte'

  interface Props {
    options: FlatFileEntry[]
    highlightIndex: number
    onSelect: (option: FlatFileEntry) => void
    /** Subtle status row shown when the @ mention file index is empty (still indexing or failed). */
    notice?: string | null
  }

  let { options, highlightIndex, onSelect, notice = null }: Props = $props()

  function formatFileSize(size?: number) {
    if (!size && size !== 0) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  function formatMtime(value?: string) {
    if (!value) return ''
    try {
      return new Date(value).toLocaleString()
    } catch {
      return ''
    }
  }

  function getMentionTitle(option: FlatFileEntry) {
    return `${option.path}${option.type === 'directory' ? ' • Folder' : option.size ? ` • ${formatFileSize(option.size)}` : ''}${option.mtime ? ` • ${formatMtime(option.mtime)}` : ''}`
  }
</script>

{#if options.length > 0 || notice}
  <div class="chat-autocomplete mention-autocomplete">
    {#if options.length === 0 && notice}
      <div class="chat-mention-notice">{notice}</div>
    {/if}
    {#each options as option, index (option.path)}
      <button
        type="button"
        class="chat-autocomplete-option is-mention {index === highlightIndex ? 'is-active' : ''}"
        onclick={() => onSelect(option)}
        title={getMentionTitle(option)}
      >
        <span class="chat-mention-main">
          <span class="chat-mention-name">{option.name}</span>
          {#if option.type === 'directory'}
            <span class="chat-mention-kind">Folder</span>
          {/if}
          <span class="chat-mention-path"> - {option.path}</span>
        </span>
        <span class="chat-mention-size">
          {option.type === 'directory' ? 'Folder' : option.size ? formatFileSize(option.size) : ''}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .chat-autocomplete {
    position: absolute;
    left: 0.5rem;
    right: 0.5rem;
    bottom: 3rem;
    z-index: var(--z-popover);
    border: 1px solid var(--bs-app-popover-line);
    border-radius: 8px;
    background: var(--bs-app-inset-surface);
    padding: 0.25rem;
    box-shadow: 0 10px 24px oklch(0 0 0 / 0.35);
  }

  .chat-autocomplete-option {
    width: 100%;
    display: flex;
    gap: 0.5rem;
    border-radius: 0.25rem;
    padding: 0.25rem 0.5rem;
    color: var(--bs-app-field-text);
    text-align: left;
    font-size: 0.75rem;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .chat-autocomplete-option.is-mention {
    align-items: center;
    justify-content: space-between;
  }

  .chat-autocomplete-option:hover,
  .chat-autocomplete-option.is-active {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .chat-mention-main {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-mention-name {
    font-weight: 600;
  }

  .chat-mention-kind {
    margin-left: 0.25rem;
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .chat-mention-path,
  .chat-mention-size {
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
  }

  .chat-mention-size {
    flex-shrink: 0;
  }

  .chat-mention-notice {
    padding: 0.25rem 0.5rem;
    color: var(--bs-app-muted-text);
    font-size: 0.7rem;
  }

</style>
