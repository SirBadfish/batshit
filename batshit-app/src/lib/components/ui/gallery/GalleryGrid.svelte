<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    minWidth = 180,
    gap = '0.75rem',
    children
  } = $props<{
    minWidth?: number
    gap?: string
    children?: Snippet
  }>()
</script>

<div
  class="grid"
  style={`grid-template-columns: repeat(auto-fill, minmax(${minWidth}px, 1fr)); gap: ${gap};`}
>
  {@render children?.()}
</div>
