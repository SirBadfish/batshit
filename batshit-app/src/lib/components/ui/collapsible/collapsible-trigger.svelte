<script lang="ts">
  import { getContext } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  
  let {
    asChild = false,
    builders = [],
    children,
    ...restProps
  } = $props<HTMLButtonAttributes & {
    asChild?: boolean
    builders?: any[]
    children?: any
  }>()
  
  const ctx = getContext<any>('collapsible')
  
  function handleClick() {
    if (!ctx.disabled) {
      ctx.open = !ctx.open
    }
  }
</script>

{#if asChild && builders?.[0]}
  {@render children?.({ builder: { ...builders[0], onclick: handleClick } })}
{:else}
  <button
    type="button"
    aria-expanded={ctx.open}
    aria-disabled={ctx.disabled}
    disabled={ctx.disabled}
    onclick={handleClick}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}