<script lang="ts">
  /**
   * Stands in for `AgentMcpDefaultsCard` in `MCPsDropdown.fieldSaves.test.ts`: it renders nothing
   * and hands the test the props MCPsDropdown gave the card (a live object, so a read is always
   * the latest), so the test can fire the card's own callbacks (`onGatewaysChange`,
   * `onDcmDisplaySettingsChange`, ...) the way the real card's controls do.
   */
  const props: Record<string, any> = $props()

  $effect(() => {
    ;(globalThis as any).__mcpCardProps = props
    return () => {
      delete (globalThis as any).__mcpCardProps
    }
  })
</script>

<div data-testid="mcp-card-stub"></div>
