<script lang="ts">
  import { getContext } from 'svelte'
  import { slide } from 'svelte/transition'
  import type { HTMLAttributes } from 'svelte/elements'
  
  let {
    children,
    ...restProps
  } = $props<HTMLAttributes<HTMLDivElement> & {
    children?: any
  }>()
  
  const ctx = getContext<any>('collapsible')
</script>

{#if ctx.open}
  <div
    transition:slide={{ duration: 200 }}
    {...restProps}
  >
    {@render children?.()}
  </div>
{/if}