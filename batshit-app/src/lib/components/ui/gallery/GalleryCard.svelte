<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    title = '',
    subtitle = '',
    selected = false,
    media,
    actions,
    header,
    meta,
    details
  } = $props<{
    title?: string
    subtitle?: string
    selected?: boolean
    media?: Snippet
    actions?: Snippet
    header?: Snippet
    meta?: Snippet
    details?: Snippet
  }>()
</script>

<div
  class={`group relative overflow-hidden rounded-lg border bg-muted/10 transition-shadow ${
    selected ? 'ring-2 ring-primary/70' : ''
  }`}
>
  <div class="relative aspect-[4/3] bg-muted/40">
    {@render media?.()}
    {#if actions}
      <div class="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {@render actions?.()}
      </div>
    {/if}
  </div>
  <div class="space-y-1 border-t px-3 py-2">
    {#if header}
      {@render header?.()}
    {:else}
      <div class="text-xs font-semibold truncate">{title}</div>
      {#if subtitle}
        <div class="text-[11px] text-muted-foreground truncate">{subtitle}</div>
      {/if}
      {@render meta?.()}
    {/if}
  </div>
  {#if details}
    <div class="border-t bg-muted/5 px-3 py-2">
      {@render details?.()}
    </div>
  {/if}
</div>
