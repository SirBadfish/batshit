<script lang="ts">
  import type {
    SlashCommandDescriptor,
    SlashCommandScope,
    SlashCommandSource
  } from '$lib/types/slashCommands'

  interface Props {
    options: SlashCommandDescriptor[]
    highlightIndex: number
    onSelect: (option: SlashCommandDescriptor) => void
    isInvocationCollision: (option: SlashCommandDescriptor) => boolean
  }

  let { options, highlightIndex, onSelect, isInvocationCollision }: Props = $props()

  function getSlashSourceClass(source: SlashCommandSource) {
    if (source === 'claude') return 'is-claude'
    if (source === 'codex') return 'is-codex'
    return 'is-batshit'
  }

  function getSlashSourceLabel(source: SlashCommandSource) {
    if (source === 'claude') return 'Claude'
    if (source === 'codex') return 'Codex'
    return 'Batshit'
  }

  function getSlashScopeLabel(scope?: SlashCommandScope) {
    if (scope === 'project') return 'project'
    if (scope === 'managed') return 'managed'
    if (scope === 'global') return 'global'
    return 'scope?'
  }
</script>

{#if options.length > 0}
  <div class="chat-autocomplete slash-autocomplete">
    {#each options as option, index (option.id)}
      <button
        type="button"
        class="chat-autocomplete-option is-slash {index === highlightIndex ? 'is-active' : ''}"
        onclick={() => onSelect(option)}
      >
        <span class={`chat-slash-source-dot ${getSlashSourceClass(option.source)}`}></span>
        <span class="chat-autocomplete-copy">
          <span class="chat-autocomplete-title-row">
            <span class="chat-autocomplete-invocation">{option.invocation}</span>
            {#if option.plugin}
              <span class="chat-autocomplete-plugin">({option.plugin})</span>
            {/if}
            <span class="chat-autocomplete-pill">
              {getSlashSourceLabel(option.source)}
            </span>
            {#if option.scope}
              <span class="chat-autocomplete-scope">
                {getSlashScopeLabel(option.scope)}
              </span>
            {/if}
          </span>
          {#if option.description}
            <span class="chat-autocomplete-hint">
              {option.description}
            </span>
          {:else if option.argumentHint}
            <span class="chat-autocomplete-hint">
              {option.argumentHint}
            </span>
          {/if}
          {#if isInvocationCollision(option)}
            <span class="chat-autocomplete-warning">
              {option.source === 'batshit'
                ? 'Collision: typed slash favors Batshit.'
                : 'Collision: select this entry to force CLI usage.'}
            </span>
          {/if}
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

  .chat-autocomplete-option.is-slash {
    align-items: flex-start;
  }

  .chat-autocomplete-option:hover,
  .chat-autocomplete-option.is-active {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .chat-slash-source-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex-shrink: 0;
    margin-top: 0.25rem;
    border-radius: 9999px;
  }

  .chat-slash-source-dot.is-claude {
    background: oklch(0.68 0.16 48);
  }

  .chat-slash-source-dot.is-codex {
    background: oklch(0.62 0.18 250);
  }

  .chat-slash-source-dot.is-batshit {
    background: var(--primary);
  }

  .chat-autocomplete-copy {
    min-width: 0;
    flex: 1 1 0;
  }

  .chat-autocomplete-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .chat-autocomplete-invocation {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .chat-autocomplete-plugin,
  .chat-autocomplete-hint {
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
  }

  .chat-autocomplete-pill,
  .chat-autocomplete-scope {
    border-radius: 0.25rem;
    padding: 0.125rem 0.375rem;
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
    text-transform: uppercase;
  }

  .chat-autocomplete-pill {
    background: var(--bs-app-field);
  }

  .chat-autocomplete-scope {
    border: 1px solid var(--bs-app-field-line);
  }

  .chat-autocomplete-hint {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-autocomplete-warning {
    display: block;
    margin-top: 0.25rem;
    color: oklch(0.72 0.12 78);
    font-size: 0.625rem;
  }
</style>
