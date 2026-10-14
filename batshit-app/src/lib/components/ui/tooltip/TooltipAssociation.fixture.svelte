<script lang="ts">
  import * as Tooltip from './index'

  let contentRef = $state<HTMLDivElement | null>(null)
  let forcedRef = $state<HTMLDivElement | null>(null)
  let forcedOpen = $state(false)
  let forcedMounted = $state(true)
  let customContentRef = $state<HTMLDivElement | null>(null)
</script>

<Tooltip.Provider delayDuration={0}>
  <Tooltip.Root>
    <Tooltip.Trigger aria-label="Default tooltip">Default</Tooltip.Trigger>
    <Tooltip.Content bind:ref={contentRef}>Default tooltip content</Tooltip.Content>
  </Tooltip.Root>
  <output data-testid="default-content-ref">{contentRef?.id ?? ''}</output>

  <Tooltip.Root>
    <Tooltip.Trigger aria-label="Explicit tooltip">Explicit</Tooltip.Trigger>
    <Tooltip.Content id="explicit-tooltip-content">Explicit tooltip content</Tooltip.Content>
  </Tooltip.Root>

  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button {...props} aria-label="Snippet tooltip">Snippet</button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>Snippet tooltip content</Tooltip.Content>
  </Tooltip.Root>
  <Tooltip.Root>
    <Tooltip.Trigger aria-label="Custom content tooltip">Custom content</Tooltip.Trigger>
    <Tooltip.Content bind:ref={customContentRef} class="custom-content">
      {#snippet child({ props, wrapperProps })}
        <div {...wrapperProps}>
          <div {...props}>Custom content tooltip body</div>
        </div>
      {/snippet}
    </Tooltip.Content>
  </Tooltip.Root>
  <output data-testid="custom-content-ref">{customContentRef?.id ?? ''}</output>
  {#if forcedMounted}
    <Tooltip.Root bind:open={forcedOpen}>
      <Tooltip.Trigger aria-label="Force-mounted tooltip">Force-mounted</Tooltip.Trigger>
      <Tooltip.Content forceMount bind:ref={forcedRef} style={`visibility: ${forcedOpen ? 'visible' : 'hidden'}; --fixture-marker: retained;`}>
        Force-mounted tooltip content
      </Tooltip.Content>
    </Tooltip.Root>
  {/if}
  <output data-testid="forced-content-ref">{forcedRef?.id ?? ''}</output>
  <button onclick={() => forcedMounted = false}>Unmount force-mounted root</button>
</Tooltip.Provider>
