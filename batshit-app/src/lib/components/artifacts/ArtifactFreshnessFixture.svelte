<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip'
  import type { Component } from 'svelte'

  let {
    component: RenderComponent,
    componentProps = {}
  }: {
    component: Component<any>
    componentProps?: Record<string, any>
  } = $props()
</script>

<Tooltip.Provider>
  <RenderComponent {...componentProps} />
</Tooltip.Provider>
