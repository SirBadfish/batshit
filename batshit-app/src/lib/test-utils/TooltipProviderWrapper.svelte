<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip'
  import type { Component } from 'svelte'

  let {
    component: RenderComponent,
    props = {}
  }: {
    component: Component<any>
    props?: Record<string, any>
  } = $props()
</script>

<Tooltip.Provider>
  <RenderComponent {...props} />
</Tooltip.Provider>
