<script lang="ts">
  import { setContext } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  let {
    open: openProp = $bindable(false),
    disabled = false,
    children,
    class: className,
    ...restProps
  } = $props<HTMLAttributes<HTMLDivElement> & {
    open?: boolean
    disabled?: boolean
    children?: any
  }>()

  let openState = $state(openProp)

  $effect(() => {
    openState = openProp
  })

  $effect(() => {
    openProp = openState
  })

  setContext('collapsible', {
    get open() { return openState },
    set open(value) { openState = value },
    get disabled() { return disabled }
  })

  const hasRootElement = $derived(Boolean(className) || Object.keys(restProps).length > 0)
</script>

{#if hasRootElement}
  <div class={className} data-state={openState ? 'open' : 'closed'} {...restProps}>
    {@render children?.()}
  </div>
{:else}
  {@render children?.()}
{/if}
