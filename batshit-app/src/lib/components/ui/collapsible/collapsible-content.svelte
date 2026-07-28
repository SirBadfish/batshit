<script lang="ts">
  import { getContext } from 'svelte'
  import { slide } from 'svelte/transition'
  import type { HTMLAttributes } from 'svelte/elements'
  
  let {
    forceMount = false,
    children,
    ...restProps
  } = $props<HTMLAttributes<HTMLDivElement> & {
    forceMount?: boolean
    children?: any
  }>()
  
  const ctx = getContext<any>('collapsible')
</script>

{#if forceMount}
  <div
    hidden={!ctx.open}
    data-state={ctx.open ? 'open' : 'closed'}
    {...restProps}
  >
    {@render children?.()}
  </div>
{:else if ctx.open}
  <div
    transition:slide={{ duration: 200 }}
    {...restProps}
  >
    {@render children?.()}
  </div>
{/if}
