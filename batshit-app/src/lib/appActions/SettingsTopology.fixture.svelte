<script lang="ts">
  import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte'
  let { sidebarMounted = true, agentMounted = true, modelMounted = true } = $props<{
    sidebarMounted?: boolean
    agentMounted?: boolean
    modelMounted?: boolean
  }>()
  let sidebarOpen = $state(false)
  let agentOpen = $state(false)
  let modelOpen = $state(false)
  let agentInitialTab = $state('agents')
  let agentInitialToolsTab = $state<'zip-options' | null>(null)
  const data = { user: { id: 'topology-user' } }
</script>

<!-- Match the actual three unconditional SettingsPanel hosts. Each has its own
     human bind:open and launcher props; only heavyweight lazy content is mocked. -->
{#if sidebarMounted}
  <SettingsPanel bind:open={sidebarOpen} {data} />
{/if}
{#if agentMounted}
  <SettingsPanel bind:open={agentOpen} {data} initialTab={agentInitialTab} initialToolsTab={agentInitialToolsTab} />
{/if}
{#if modelMounted}
  <SettingsPanel bind:open={modelOpen} {data} initialTab="models" />
{/if}
<button type="button" onclick={() => { sidebarOpen = true }}>Human sidebar Settings</button>
<button type="button" onclick={() => { agentOpen = true }}>Human agent Settings</button>
<button type="button" onclick={() => { modelOpen = true }}>Human model Settings</button>
<button type="button" onclick={() => { agentInitialTab = 'tools'; agentInitialToolsTab = 'zip-options' }}>Human agent Zip Options</button>
<output data-testid="topology-owners">{JSON.stringify({ sidebar: sidebarOpen, agent: agentOpen, model: modelOpen })}</output>
