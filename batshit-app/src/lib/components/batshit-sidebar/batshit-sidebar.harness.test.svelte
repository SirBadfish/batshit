<script lang="ts">
  import * as Sidebar from '$lib/components/ui/sidebar'
  import BatshitSidebar from './batshit-sidebar.svelte'
  import AgentSelector from '$lib/components/agents/AgentSelector.svelte'

  let { data, withAgentSelector = false }: { data: any; withAgentSelector?: boolean } = $props()
</script>

<Sidebar.SidebarProvider>
  <BatshitSidebar {data} />
  {#if withAgentSelector}
    <AgentSelector {data} />
  {/if}
</Sidebar.SidebarProvider>
