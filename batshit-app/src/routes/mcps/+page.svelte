<script lang="ts">
  import MCPSettingsPanel from '$lib/components/settings/panels/MCPSettingsPanel.svelte'

  const { data } = $props()
</script>

<MCPSettingsPanel {data} mode="page" />
