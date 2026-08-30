<script lang="ts">
  /**
   * MCP Gateways Management Panel (Svelte 5)
   * Reused by both the standalone /mcps route and the settings sheet tab.
   *
   * Displays and manages all gateway types:
   * - Docker MCP Gateway
   * - n8n MCP Trigger Gateways
   * - Synthetic n8n MCP Clients (read-only)
   *
   * CRITICAL: Uses Svelte 5 runes ($state, $derived, $effect)
   */
  import { goto } from '$app/navigation'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Card from '$lib/components/ui/card'
  import * as Tabs from '$lib/components/ui/tabs'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import MCPIcon from '$lib/components/icons/MCPIcon.svelte'
  import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import {
    ArrowLeft,
    ChevronDown,
    RefreshCw,
    Plus,
    Container,
    Workflow,
    Cog,
    Grid3X3,
    Trash2
  } from '@lucide/svelte'
  import { cn } from '$lib/utils'
  import GatewayCard from '$lib/components/mcps/GatewayCard.svelte'
  import GatewayInlineSettingsCards from '$lib/components/mcps/GatewayInlineSettingsCards.svelte'
  import GlobalToolGrid from '$lib/components/mcps/GlobalToolGrid.svelte'
  import ZipVisualIndicatorsCard from '$lib/components/settings/ZipVisualIndicatorsCard.svelte'
  import N8nGatewayForm from '$lib/components/mcps/N8nGatewayForm.svelte'
  import CustomGatewayForm from '$lib/components/mcps/CustomGatewayForm.svelte'
  import StdioGatewayForm from '$lib/components/mcps/StdioGatewayForm.svelte'
  import CliToolsManager from '$lib/components/tools/CliToolsManager.svelte'
  import type { MCPGateway } from '$lib/types/database'
  import { toast } from '$lib/components/ui/sonner/settings-toast'

  type PanelData = {
    user?: { id: string } | null
  } | null

  interface Props {
    data?: PanelData
    mode?: 'panel' | 'page'
    initialToolsTab?: 'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options'
  }

  let { data = null, mode = 'panel', initialToolsTab = 'gateway-settings' }: Props = $props()

  function normalizeToolsTab(
    value?: 'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options'
  ): 'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options' {
    if (value === 'tool-grid' || value === 'zip-options' || value === 'gateway-settings' || value === 'cli-tools') {
      return value
    }
    return 'gateway-settings'
  }

  // Local state using $state
  let activeTab = $state<'tool-grid' | 'gateway-settings' | 'cli-tools' | 'zip-options'>('gateway-settings')
  let lastInitialToolsTab = $state<'tool-grid' | 'gateway-settings' | 'cli-tools' | 'zip-options'>('gateway-settings')
  let gateways = $state<MCPGateway[]>([])
  let loading = $state(false)
  let showAddGatewayForm = $state<'docker' | 'n8n' | 'n8nInstance' | 'custom' | 'stdio' | null>(null)
  let selectedGatewayId = $state<string | null>(null)
  let deleteBusy = $state(false)
  let deleteDisclosureOpen = $state(false)
  const SYNTHETIC_NOTICE =
    'Direct MCP clients are auto-discovered from n8n workflows and are managed inside n8n.'

  function isSyntheticGateway(gatewayId: string | null): boolean {
    if (!gatewayId) return false
    const gateway = gateways.find((g) => g.id === gatewayId)
    return gateway?.type === 'n8n-mcp-client'
  }

  // Load gateways on mount + whenever user changes
  $effect(() => {
    if (data?.user?.id) {
      loadGateways()
    }
  })

  $effect(() => {
    const normalized = normalizeToolsTab(initialToolsTab)
    if (normalized !== lastInitialToolsTab) {
      activeTab = normalized
      lastInitialToolsTab = normalized
    }
  })

  $effect(() => {
    if (sortedGateways.length === 0) {
      selectedGatewayId = null
      return
    }

    if (!selectedGatewayId || !sortedGateways.some((gateway) => gateway.id === selectedGatewayId)) {
      selectedGatewayId = sortedGateways[0]?.id ?? null
    }
  })

  $effect(() => {
    selectedGatewayId
    deleteDisclosureOpen = false
  })

  function getGatewayTypeLabel(gateway: MCPGateway): string {
    switch (gateway.type) {
      case 'docker-catalog':
        return 'Docker Catalog'
      case 'n8n-mcp-trigger':
        return 'n8n MCP Trigger'
      case 'n8n-instance-mcp':
        return 'n8n Instance MCP'
      case 'stdio':
        return 'STDIO MCP'
      case 'n8n-mcp-client':
        return 'n8n MCP Client'
      case 'custom':
        return 'Custom Gateway'
      default:
        return gateway.type
    }
  }

  function getGatewayToolCount(gateway: MCPGateway): number {
    const metadataCount = Array.isArray(gateway.metadata?.toolNames) ? gateway.metadata.toolNames.length : 0
    const discoveredCount = gateway.discoveredTools?.length || 0
    const stdioCount = gateway.type === 'stdio' ? gateway.stdioConfig?.toolCount || 0 : 0
    return Math.max(metadataCount, discoveredCount, stdioCount)
  }

  function getGatewaySidebarSubtext(gateway: MCPGateway): string {
    const typeLabel = getGatewayTypeLabel(gateway)
    const toolCount = getGatewayToolCount(gateway)
    return `${typeLabel} • ${toolCount} tool${toolCount === 1 ? '' : 's'}`
  }

  function getGatewayIconRef(gateway: MCPGateway) {
    return normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF)
  }

  let sortedGateways = $derived.by(() =>
    [...gateways].sort((a, b) => a.name.localeCompare(b.name))
  )

  let selectedGatewayDetail = $derived.by(
    () => sortedGateways.find((gateway) => gateway.id === selectedGatewayId) ?? null
  )

  // Load gateways from API
  async function loadGateways() {
    if (!data?.user?.id) return

    loading = true
    try {
      const response = await fetch(`/api/mcp/gateways?userId=${data.user.id}`)

      if (!response.ok) {
        throw new Error(`Failed to load gateways: ${response.statusText}`)
      }

      const responseData = await response.json()
      gateways = responseData.gateways || []
    } catch (error) {
      console.error('[MCP Settings] Error loading gateways:', error)
      toast.error('Failed to load gateways')
    } finally {
      loading = false
    }
  }

  // Handle gateway refresh
  async function handleRefreshGateway(gatewayId: string) {
    if (isSyntheticGateway(gatewayId)) {
      toast.info(SYNTHETIC_NOTICE)
      return
    }

    try {
      const response = await fetch(`/api/mcp/gateways/${gatewayId}/refresh`, {
        method: 'POST'
      })

      const result = await response.json()

      if (response.ok && result.success) {
        toast.success(`Gateway refreshed: ${result.tools?.length || 0} tools discovered`)
        await loadGateways() // Reload to show updated tool count
      } else {
        const errorMsg = result.error || 'Unknown error'
        toast.error(`Gateway refresh failed: ${errorMsg}`)
      }
    } catch (error) {
      console.error('[MCP Settings] Error refreshing gateway:', error)
      toast.error('Failed to refresh gateway: Network error')
    }
  }

  // Handle gateway delete
  async function handleDeleteGateway(gatewayId: string) {
    if (isSyntheticGateway(gatewayId)) {
      toast.info(SYNTHETIC_NOTICE)
      return
    }

    try {
      deleteBusy = true
      const response = await fetch(`/api/mcp/gateways/${gatewayId}?userId=${data?.user?.id}`, {
        method: 'DELETE'
      })

      if (!response.ok) throw new Error('Failed to delete gateway')

      toast.success('Gateway deleted successfully')
      deleteDisclosureOpen = false
      await loadGateways()
    } catch (error) {
      console.error('[MCP Settings] Error deleting gateway:', error)
      toast.error('Failed to delete gateway')
    } finally {
      deleteBusy = false
    }
  }

  // Handle add Docker gateway
  async function handleAddDockerGateway() {
    try {
      const existing = gateways.find((g) => g.type === 'docker-catalog')
      if (existing) {
        toast.error('Docker Gateway already exists')
        return
      }

      const response = await fetch('/api/mcp/gateways', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: data?.user?.id,
          name: 'Docker MCP Gateway',
          type: 'docker-catalog',
          url: 'http://localhost:8080/mcp',
          enabled: true,
          autoStart: false
        })
      })

      if (!response.ok) throw new Error('Failed to create Docker gateway')

      toast.success('Docker Gateway added successfully')
      await loadGateways()
    } catch (error) {
      console.error('[MCP Settings] Error adding Docker gateway:', error)
      toast.error('Failed to add Docker gateway')
    }
  }

  // Handle add n8n gateway
  function handleAddN8nGateway() {
    showAddGatewayForm = 'n8n'
  }

  function handleAddN8nInstanceGateway() {
    showAddGatewayForm = 'n8nInstance'
  }

  function handleAddCustomGateway() {
    showAddGatewayForm = 'custom'
  }

  function handleAddStdioGateway() {
    showAddGatewayForm = 'stdio'
  }

  function handleGatewayUpdated(updatedGateway: MCPGateway) {
    gateways = gateways.map((gateway) => (gateway.id === updatedGateway.id ? updatedGateway : gateway))
  }

  function handleBack() {
    if (mode === 'page') {
      goto('/')
    }
  }
</script>

<div class="bs-settings-panel-native flex h-full flex-col">
  {#if mode === 'page'}
    <div class="px-6 py-4">
      <Button variant="ghost" size="icon" onclick={handleBack}>
        <ArrowLeft  />
      </Button>
    </div>
  {/if}

  <div class={`bs-settings-scroll-wrap flex-1 ${mode === 'page' ? 'overflow-auto' : ''}`}>
    <div class="space-y-6">
      <Tabs.Root bind:value={activeTab} class="w-full">
        <Tabs.List class="flex w-full flex-wrap gap-2">
          <Tabs.Trigger value="gateway-settings" class="min-w-[104px] flex-1 gap-2 sm:flex-none">
            <MCPIcon size="sm" class="h-3.5 w-3.5" />
            <span>MCP Sources</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="cli-tools" class="min-w-[104px] flex-1 gap-2 sm:flex-none">
            <BatshitIcon id="cli-tools" class="h-3.5 w-3.5" />
            <span>CLI Tools</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="tool-grid" class="min-w-[132px] flex-1 gap-2 sm:flex-none">
            <Grid3X3 class="h-3.5 w-3.5" />
            <span>Global Tool Grid</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="zip-options" class="min-w-[104px] flex-1 gap-2 sm:flex-none">
            <BatshitIcon id="zip" class="h-3.5 w-3.5" />
            <span>Zip Options</span>
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      {#if activeTab === 'gateway-settings'}
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <h3 class="batshit-settings-section-title">MCP Sources</h3>
              <SettingsInfoMenu ariaLabel="About MCP Sources" contentClass="w-80">
                <p>
                  MCP Sources can be MCP Gateways or direct MCP Servers. Batshit lists both here so
                  you can manage how tool sources are connected and grouped.
                </p>
              </SettingsInfoMenu>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onclick={loadGateways} disabled={loading}>
                <RefreshCw class={`${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class={cn(
                    buttonVariants({ size: 'sm' }),
                    'batshit-button batshit-button-medium batshit-button-medium-primary'
                  )}
                >
                  <Plus class="h-4 w-4" />
                  Add MCP Source
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Item onclick={handleAddDockerGateway}>
                    <Container class="mr-2 h-4 w-4" />
                    Docker MCP Gateway
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onclick={handleAddN8nGateway}>
                    <Workflow class="mr-2 h-4 w-4" />
                    n8n MCP Trigger Gateway
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onclick={handleAddN8nInstanceGateway}>
                    <Workflow class="mr-2 h-4 w-4" />
                    n8n Instance MCP Gateway
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onclick={handleAddCustomGateway}>
                    <Cog class="mr-2 h-4 w-4" />
                    Custom Gateway
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onclick={handleAddStdioGateway}>
                    <Cog class="mr-2 h-4 w-4" />
                    STDIO MCP Server
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </div>

          {#if loading && gateways.length === 0}
            <div class="batshit-settings-empty-state">
              <RefreshCw class="mr-2 h-4 w-4 animate-spin" />
              Loading MCP sources…
            </div>
          {:else if sortedGateways.length === 0}
            <Card.Root class="batshit-settings-card batshit-settings-card-default">
              <Card.Content class="batshit-settings-card-empty space-y-4">
                <div class="batshit-settings-inline-strong">No MCP sources yet</div>
                <p class="batshit-settings-caption">
                  Add a gateway to connect Docker, n8n, STDIO, or another MCP source.
                </p>
                <div class="flex justify-center">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      class={cn(
                        buttonVariants(),
                        'batshit-button batshit-button-large batshit-button-large-primary'
                      )}
                    >
                      <Plus class="h-4 w-4" />
                      Add Your First MCP Source
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item onclick={handleAddDockerGateway}>Docker MCP Gateway</DropdownMenu.Item>
                      <DropdownMenu.Item onclick={handleAddN8nGateway}>n8n MCP Trigger Gateway</DropdownMenu.Item>
                      <DropdownMenu.Item onclick={handleAddN8nInstanceGateway}>n8n Instance MCP Gateway</DropdownMenu.Item>
                      <DropdownMenu.Item onclick={handleAddCustomGateway}>Custom Gateway</DropdownMenu.Item>
                      <DropdownMenu.Item onclick={handleAddStdioGateway}>STDIO MCP Server</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              </Card.Content>
            </Card.Root>
          {:else}
            <div class="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <Card.Root class="batshit-settings-card batshit-settings-card-default">
                <Card.Header class="pb-2">
                  <Card.Title>Saved Sources</Card.Title>
                </Card.Header>
                <Card.Content class="batshit-settings-card-content-flush">
                  <div class="settings-sidebar-items">
                    {#each sortedGateways as gateway (gateway.id)}
                      <button
                        type="button"
                        class="settings-sidebar-item settings-sidebar-item-with-avatar"
                        data-state={gateway.id === selectedGatewayId ? 'active' : 'inactive'}
                        onclick={() => (selectedGatewayId = gateway.id)}
                      >
                        <div class="settings-sidebar-item-media pt-0.5">
                          <div class="batshit-settings-icon-frame h-9 w-9">
                            <IconRenderer
                              ref={getGatewayIconRef(gateway)}
                              label={gateway.name}
                              iconClass="h-5 w-5 text-muted-foreground"
                            />
                          </div>
                        </div>
                        <div class="settings-sidebar-item-content">
                          <span class="settings-sidebar-item-title truncate">{gateway.name}</span>
                          <span class="settings-sidebar-item-subtext truncate">
                            {getGatewaySidebarSubtext(gateway)}
                          </span>
                        </div>
                      </button>
                    {/each}
                  </div>
                </Card.Content>
              </Card.Root>

              <div class="space-y-4">
                {#if selectedGatewayDetail}
                  <GatewayCard
                    gateway={selectedGatewayDetail}
                    viewMode="grid"
                    showFooterActions={false}
                    showHeaderRefresh={selectedGatewayDetail.type !== 'n8n-mcp-client'}
                    onRefresh={() => handleRefreshGateway(selectedGatewayDetail.id)}
                  />
                  <GatewayInlineSettingsCards
                    gateway={selectedGatewayDetail}
                    userId={data?.user?.id ?? null}
                    onGatewayUpdated={handleGatewayUpdated}
                  />
                  {#if selectedGatewayDetail.type !== 'n8n-mcp-client'}
                    <Collapsible.Root bind:open={deleteDisclosureOpen}>
                      <div>
                        <Collapsible.Trigger class="batshit-settings-delete-trigger">
                          <span class="batshit-settings-delete-trigger-label">
                            <Trash2 class="batshit-settings-delete-trigger-icon" />
                            Delete MCP Source
                          </span>
                          <ChevronDown
                            class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                          />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="batshit-settings-delete-content">
                          <div class="batshit-settings-delete-content-inner">
                            <div class="batshit-settings-delete-copy">
                              <p>Permanently removes this MCP source from Batshit.</p>
                              <p>Use this when the source is obsolete or should be rebuilt cleanly.</p>
                            </div>
                            <Button
                              variant="destructive"
                              size="sm"
                              class="batshit-settings-delete-action"
                              onclick={() => handleDeleteGateway(selectedGatewayDetail.id)}
                              disabled={deleteBusy}
                            >
                              {#if deleteBusy}
                                <RefreshCw class="batshit-settings-delete-action-icon is-spinning" />
                              {:else}
                                <Trash2 class="batshit-settings-delete-action-icon" />
                              {/if}
                              Delete MCP Source
                            </Button>
                          </div>
                        </Collapsible.Content>
                      </div>
                    </Collapsible.Root>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else if activeTab === 'cli-tools'}
        <CliToolsManager userId={data?.user?.id ?? null} />
      {:else if activeTab === 'tool-grid'}
        <GlobalToolGrid userId={data?.user?.id ?? null} />
      {:else}
        <div class="space-y-4">
          <ZipVisualIndicatorsCard {data} />
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- n8n MCP Trigger Gateway Form -->
<N8nGatewayForm
  open={showAddGatewayForm === 'n8n'}
  onOpenChange={(open) => {
    if (!open) showAddGatewayForm = null
  }}
  onSuccess={loadGateways}
  userId={data?.user?.id}
/>

<N8nGatewayForm
  open={showAddGatewayForm === 'n8nInstance'}
  gatewayType="n8n-instance-mcp"
  onOpenChange={(open) => {
    if (!open) showAddGatewayForm = null
  }}
  onSuccess={loadGateways}
  userId={data?.user?.id}
/>

<CustomGatewayForm
  open={showAddGatewayForm === 'custom'}
  onOpenChange={(open) => {
    if (!open) showAddGatewayForm = null
  }}
  onSuccess={loadGateways}
  userId={data?.user?.id}
/>

<StdioGatewayForm
  open={showAddGatewayForm === 'stdio'}
  onOpenChange={(open) => {
    if (!open) showAddGatewayForm = null
  }}
  onSuccess={loadGateways}
  userId={data?.user?.id}
/>
