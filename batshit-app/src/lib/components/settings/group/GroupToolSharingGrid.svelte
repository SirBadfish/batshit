<script lang="ts">
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Switch from '$lib/components/ui/switch'
  import ShareRowsSection from '$lib/components/settings/group/ShareRowsSection.svelte'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import {
    DEFAULT_CLI_TOOL_ICON_REF,
    DEFAULT_MCP_GATEWAY_ICON_REF,
    DEFAULT_MCP_GROUP_ICON_REF
  } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import type { IconRef } from '$lib/icons/iconTypes'
  import {
    buildGatewayGroupsFromCache,
    resolveGatewayToolGroups,
    type GatewayToolsResponse,
    type ToolGridGroupRow
  } from '$lib/components/mcps/gatewayToolCatalog'
  import { AlertCircle, ChevronDown, Loader2 } from '@lucide/svelte'
  import type { MCPGateway } from '$lib/types/database'
  import {
    SHARED_NON_MCP_TOOL_GRID_CONFIG,
    SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS,
    SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS,
    TOOL_GRID_BATSHIT_SECTION_ICON_REF,
    TOOL_GRID_OTHER_SECTION_ICON_REF,
    getSharedNonMcpToolGridShareKey
  } from '$lib/components/tools/toolGridConfig'
  import { canonicalToolName } from '$lib/utils/toolRenderMap'
  import { CLI_TOOL_GRID_GROUP_NAME } from '$lib/utils/toolGridCli'

  type GroupRow = ToolGridGroupRow

  interface GatewayRow {
    id: string
    name: string
    iconRef: IconRef
    groups: GroupRow[]
  }

  interface ShareRow {
    id: string
    label: string
    title?: string
    iconRef?: IconRef | null
    infoParagraphs?: string[]
  }

  interface Props {
    userId?: string | null
    sharedTools?: string[]
    onSharedToolsChange?: (sharedTools: string[]) => void
    refreshNonce?: number
  }

  let {
    userId = null,
    sharedTools = [],
    onSharedToolsChange = () => {},
    refreshNonce = 0
  }: Props = $props()

  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let gateways = $state<GatewayRow[]>([])
  let cliTools = $state<ShareRow[]>([])
  let openTopLevelAccordionItemKey = $state<string | null>(null)
  let openNestedAccordionItemKey = $state<string | null>(null)

  const topLevelAccordionRowClass = 'batshit-settings-accordion-row'
  const nestedAccordionRowClass = 'batshit-settings-accordion-row is-nested'

  const batshitRows: ShareRow[] = SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS.map((rowId) => ({
    id: getSharedNonMcpToolGridShareKey(rowId),
    label: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].label,
    iconRef: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].iconRef,
    infoParagraphs: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].infoParagraphs
  }))

  const otherRows: ShareRow[] = SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS.map((rowId) => ({
    id: getSharedNonMcpToolGridShareKey(rowId),
    label: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].label,
    iconRef: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].iconRef,
    infoParagraphs: SHARED_NON_MCP_TOOL_GRID_CONFIG[rowId].infoParagraphs
  }))

  const normalizedSharedTools = $derived(normalizeSharedToolList(sharedTools))
  const normalizedSharedToolSet = $derived(
    new Set(normalizedSharedTools.map((entry) => normalizeToolKey(entry)))
  )

  function normalizeToolKey(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return ''
    return canonicalToolName(trimmed).toLowerCase()
  }

  function normalizeSharedToolList(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const output: string[] = []

    for (const entry of value) {
      if (typeof entry !== 'string') continue
      const normalized = entry.trim()
      if (!normalized) continue
      const key = normalizeToolKey(normalized)
      if (!key || seen.has(key)) continue
      seen.add(key)
      output.push(normalized)
    }

    return output.sort((left, right) => left.localeCompare(right))
  }

  function setSharedTools(next: string[]) {
    onSharedToolsChange(normalizeSharedToolList(next))
  }

  function isToolShared(toolName: string): boolean {
    return normalizedSharedToolSet.has(normalizeToolKey(toolName))
  }

  function setToolShared(toolName: string, shared: boolean) {
    const targetKey = normalizeToolKey(toolName)
    let next = normalizedSharedTools.filter((entry) => normalizeToolKey(entry) !== targetKey)
    if (shared) {
      next = [...next, toolName]
    }
    setSharedTools(next)
  }

  function setManyShared(toolNames: string[], shared: boolean) {
    const keys = new Set(toolNames.map((name) => normalizeToolKey(name)).filter(Boolean))
    let next = normalizedSharedTools.filter((entry) => !keys.has(normalizeToolKey(entry)))
    if (shared) {
      next = [...next, ...toolNames]
    }
    setSharedTools(next)
  }

  function areAllToolsShared(toolNames: string[]): boolean {
    if (toolNames.length === 0) return false
    return toolNames.every((toolName) => isToolShared(toolName))
  }

  function collectGroupToolNames(group: GroupRow): string[] {
    return group.tools.map((tool) => tool.id)
  }

  function collectGatewayToolNames(gateway: GatewayRow): string[] {
    return gateway.groups.flatMap((group) => collectGroupToolNames(group))
  }

  function collectShareRowIds(rows: ShareRow[]): string[] {
    return rows.map((row) => row.id)
  }

  function getGroupIconRef(group: GroupRow): IconRef {
    return normalizeIconRef(group.iconRef, DEFAULT_MCP_GROUP_ICON_REF)
  }

  function getCliToolIconRef(tool: ShareRow): IconRef {
    return normalizeIconRef(tool.iconRef, DEFAULT_CLI_TOOL_ICON_REF)
  }

  function buildGroupKey(gatewayId: string, groupName: string): string {
    return `${gatewayId}::${groupName}`
  }

  function buildSourceKey(sourceId: string): string {
    return `mcp-source::${sourceId}`
  }

  function toggleTopLevelAccordionItem(itemKey: string) {
    openTopLevelAccordionItemKey =
      openTopLevelAccordionItemKey === itemKey ? null : itemKey
    openNestedAccordionItemKey = null
  }

  function toggleNestedAccordionItem(itemKey: string) {
    openNestedAccordionItemKey =
      openNestedAccordionItemKey === itemKey ? null : itemKey
  }

  function isInteractiveHeaderElement(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest('button, a, input, select, textarea, [contenteditable="true"]'))
  }

  function handleTopLevelHeaderClick(event: MouseEvent, itemKey: string) {
    if (isInteractiveHeaderElement(event.target)) return
    toggleTopLevelAccordionItem(itemKey)
  }

  function handleGroupHeaderClick(event: MouseEvent, groupKey: string) {
    if (isInteractiveHeaderElement(event.target)) return
    toggleNestedAccordionItem(groupKey)
  }

  async function loadCatalog() {
    if (!userId) {
      gateways = []
      loadError = null
      return
    }

    loading = true
    loadError = null

    try {
      const gatewayResponse = await fetch('/api/mcp/gateways?enabled=true')
      if (!gatewayResponse.ok) {
        throw new Error('Failed to load MCP gateways')
      }

      const gatewayPayload = await gatewayResponse.json()
      const gatewayList = Array.isArray(gatewayPayload?.gateways)
        ? (gatewayPayload.gateways as MCPGateway[])
        : []

      const interactiveGateways = gatewayList
        .filter((gateway) => gateway.enabled && gateway.type !== 'n8n-mcp-client')
        .sort((left, right) => left.name.localeCompare(right.name))

      const gatewayRows = await Promise.all(
        interactiveGateways.map(async (gateway) => {
          try {
            const toolsResponse = await fetch(`/api/mcp/gateways/${gateway.id}/tools`)
            if (!toolsResponse.ok) {
              throw new Error(`Failed to load tools for ${gateway.name}`)
            }

            const toolsPayload = (await toolsResponse.json()) as GatewayToolsResponse

            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              groups: resolveGatewayToolGroups(gateway, toolsPayload)
            }
          } catch (error) {
            console.warn('[GroupToolSharingGrid] Failed to load tools for gateway:', gateway.id, error)
            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              groups: buildGatewayGroupsFromCache(gateway)
            }
          }
        })
      )

      try {
        const cliToolsResponse = await fetch('/api/cli-tools')
        if (!cliToolsResponse.ok) {
          throw new Error('Failed to load CLI tools')
        }
        const cliToolsPayload = (await cliToolsResponse.json()) as {
          tools?: Array<Record<string, unknown>>
        }
        cliTools = Array.isArray(cliToolsPayload.tools)
          ? cliToolsPayload.tools
              .filter((tool) => (tool.status ?? 'active') === 'active')
              .map((tool) => ({
                id: typeof tool.toolId === 'string' ? tool.toolId : '',
                label:
                  typeof tool.title === 'string' && tool.title.trim().length > 0
                    ? tool.title
                    : typeof tool.toolId === 'string'
                      ? tool.toolId
                      : 'CLI Tool',
                title:
                  typeof tool.toolId === 'string' && typeof tool.title === 'string'
                    ? `${tool.title} (${tool.toolId})`
                    : typeof tool.toolId === 'string'
                      ? tool.toolId
                      : undefined,
                iconRef: normalizeIconRef(
                  tool.iconRef ?? tool.icon_ref ?? tool.iconHint,
                  DEFAULT_CLI_TOOL_ICON_REF
                )
              }))
              .filter((tool) => tool.id.trim().length > 0)
              .sort((left, right) => left.label.localeCompare(right.label))
          : []
      } catch (error) {
        console.warn('[GroupToolSharingGrid] Failed to load CLI tools:', error)
        cliTools = []
      }

      gateways = gatewayRows
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to load tool sharing grid'
      gateways = []
    } finally {
      loading = false
    }
  }

  $effect(() => {
    userId
    refreshNonce
    void loadCatalog()
  })
</script>

{#if loading}
  <div
    class="flex items-center gap-2 batshit-settings-inline-alert"
  >
    <Loader2 class="h-3.5 w-3.5 animate-spin" />
    Loading gateways...
  </div>
{:else if loadError}
  <div class="batshit-settings-inline-alert is-danger">
    <div class="flex items-center gap-2">
      <AlertCircle class="h-3.5 w-3.5" />
      <span>{loadError}</span>
    </div>
  </div>
{:else}
  <div class="batshit-settings-table-frame w-full">
    <table class="w-full min-w-[520px] table-fixed text-xs">
      <colgroup>
        <col class="w-[420px]" />
        <col class="w-[100px]" />
      </colgroup>
      <thead class="batshit-settings-table-head">
        <tr>
          <th class="batshit-settings-table-head-cell">Item</th>
          <th class="batshit-settings-table-head-cell">Share</th>
        </tr>
      </thead>
      <tbody>
        <ShareRowsSection
          sectionKey="__group_batshit_tools__"
          title="Batshit Tools"
          sectionIconRef={TOOL_GRID_BATSHIT_SECTION_ICON_REF}
          typeLabel="Batshit Tool"
          rows={batshitRows}
          open={openTopLevelAccordionItemKey === '__group_batshit_tools__'}
          {topLevelAccordionRowClass}
          {isToolShared}
          {setToolShared}
          {setManyShared}
          onHeaderClick={handleTopLevelHeaderClick}
          onToggle={toggleTopLevelAccordionItem}
        />

        {#if cliTools.length > 0}
          {@const cliToolIds = collectShareRowIds(cliTools)}
          {@const cliToolsShared = areAllToolsShared(cliToolIds)}
          {@const cliToolsKey = '__group_cli_tools__'}
          {@const cliToolsExpanded = openTopLevelAccordionItemKey === cliToolsKey}
          <Collapsible.Root open={cliToolsExpanded}>
            <tr
              class={`${topLevelAccordionRowClass} cursor-pointer`}
              onclick={(event) => handleTopLevelHeaderClick(event, cliToolsKey)}
            >
              <td class="batshit-settings-table-cell is-strong">
                <div class="batshit-settings-tool-grid-label">
                  <ToolGridIdentityIcon
                    ref={DEFAULT_CLI_TOOL_ICON_REF}
                    typeLabel="Tool Group"
                    name={CLI_TOOL_GRID_GROUP_NAME}
                  />
                  <span class="batshit-settings-tool-grid-name block truncate" title={CLI_TOOL_GRID_GROUP_NAME}>{CLI_TOOL_GRID_GROUP_NAME}</span>
                </div>
              </td>
              <td class="batshit-settings-table-cell">
                <div class="flex items-center justify-between">
                  <Switch.Root
                    checked={cliToolsShared}
                    disabled={cliToolIds.length === 0}
                    onCheckedChange={(checked) => setManyShared(cliToolIds, checked === true)}
                  />
                  <Collapsible.Trigger
                    class="ml-2 flex items-center justify-end"
                    aria-expanded={cliToolsExpanded}
                    aria-label={`Toggle tools for ${CLI_TOOL_GRID_GROUP_NAME}`}
                    onclick={() => toggleTopLevelAccordionItem(cliToolsKey)}
                  >
                    <ChevronDown
                      class={`h-3.5 w-3.5 transition-transform ${cliToolsExpanded ? 'rotate-180' : ''}`}
                    />
                  </Collapsible.Trigger>
                </div>
              </td>
            </tr>
            <tr class="batshit-settings-table-row is-flush">
              <td colspan="2" class="batshit-settings-table-cell is-flush">
                <Collapsible.Content class="overflow-hidden">
                  <table class="w-full min-w-[520px] table-fixed text-xs">
                    <colgroup>
                      <col class="w-[420px]" />
                      <col class="w-[100px]" />
                    </colgroup>
                    <tbody>
                      {#each cliTools as tool (tool.id)}
                        <tr class="batshit-settings-table-row">
                          <td class="batshit-settings-table-cell is-muted is-nested">
                            <div class="batshit-settings-tool-grid-label">
                              <ToolGridIdentityIcon
                                ref={getCliToolIconRef(tool)}
                                typeLabel="CLI Tool"
                                name={tool.label}
                              />
                              <span
                                class="batshit-settings-tool-grid-name block truncate"
                                title={tool.title ?? tool.label}
                              >
                                {tool.label}
                              </span>
                            </div>
                          </td>
                          <td class="batshit-settings-table-cell">
                            <Switch.Root
                              checked={isToolShared(tool.id)}
                              onCheckedChange={(checked) => setToolShared(tool.id, checked === true)}
                            />
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </Collapsible.Content>
              </td>
            </tr>
          </Collapsible.Root>
        {/if}

        {#each gateways as gateway (gateway.id)}
          {@const gatewayToolNames = collectGatewayToolNames(gateway)}
          {@const gatewayShared = areAllToolsShared(gatewayToolNames)}
          {@const sourceKey = buildSourceKey(gateway.id)}
          {@const sourceExpanded = openTopLevelAccordionItemKey === sourceKey}
          <Collapsible.Root open={sourceExpanded}>
            <tr
              class={`${topLevelAccordionRowClass} cursor-pointer`}
              onclick={(event) => handleTopLevelHeaderClick(event, sourceKey)}
            >
              <td class="batshit-settings-table-cell is-strong">
                <div class="batshit-settings-tool-grid-label">
                  <ToolGridIdentityIcon
                    ref={gateway.iconRef}
                    typeLabel="MCP Source"
                    name={gateway.name}
                  />
                  <span class="batshit-settings-tool-grid-name block truncate" title={`MCP Source: ${gateway.name}`}>
                    {gateway.name}
                  </span>
                </div>
              </td>
              <td class="batshit-settings-table-cell">
                <div class="flex items-center justify-between">
                  <Switch.Root
                    checked={gatewayShared}
                    disabled={gatewayToolNames.length === 0}
                    onCheckedChange={(checked) =>
                      setManyShared(gatewayToolNames, checked === true)}
                  />
                  <Collapsible.Trigger
                    class="ml-2 flex items-center justify-end"
                    aria-expanded={sourceExpanded}
                    aria-label={`Toggle groups for MCP Source ${gateway.name}`}
                    onclick={() => toggleTopLevelAccordionItem(sourceKey)}
                  >
                    <ChevronDown
                      class={`h-3.5 w-3.5 transition-transform ${sourceExpanded ? 'rotate-180' : ''}`}
                    />
                  </Collapsible.Trigger>
                </div>
              </td>
            </tr>
            <tr class="batshit-settings-table-row is-flush">
              <td colspan="2" class="batshit-settings-table-cell is-flush">
                <Collapsible.Content class="overflow-hidden">
                  <table class="w-full min-w-[520px] table-fixed text-xs">
                    <colgroup>
                      <col class="w-[420px]" />
                      <col class="w-[100px]" />
                    </colgroup>
                    <tbody>
          {#if gateway.groups.length === 0}
                      <tr class="batshit-settings-table-row">
                        <td colspan="2" class="batshit-settings-table-cell is-muted is-nested">
                          No groups discovered in this MCP Source.
                        </td>
                      </tr>
          {/if}

          {#each gateway.groups as group}
            {@const groupToolNames = collectGroupToolNames(group)}
            {@const groupShared = areAllToolsShared(groupToolNames)}
            {@const groupKey = buildGroupKey(gateway.id, group.name)}
            {@const groupExpanded = openNestedAccordionItemKey === groupKey}
            <Collapsible.Root open={groupExpanded}>
              <tr
                class={`${nestedAccordionRowClass} cursor-pointer`}
                onclick={(event) => handleGroupHeaderClick(event, groupKey)}
              >
                <td class="batshit-settings-table-cell is-strong">
                  <div class="batshit-settings-tool-grid-label is-group">
                    <ToolGridIdentityIcon
                      ref={getGroupIconRef(group)}
                      typeLabel="MCP Group"
                      name={group.name}
                    />
                    <span class="batshit-settings-tool-grid-name block truncate" title={`MCP Group: ${group.name}`}>{group.name}</span>
                  </div>
                </td>
                <td class="batshit-settings-table-cell">
                  <div class="flex items-center justify-between">
                    <Switch.Root
                      checked={groupShared}
                      disabled={groupToolNames.length === 0}
                      onCheckedChange={(checked) =>
                        setManyShared(groupToolNames, checked === true)}
                    />
                    <Collapsible.Trigger
                      class="ml-2 flex items-center justify-end"
                      aria-expanded={groupExpanded}
                      aria-label={`Toggle tools for group ${group.name}`}
                      onclick={() => toggleNestedAccordionItem(groupKey)}
                    >
                      <ChevronDown
                        class={`h-3.5 w-3.5 transition-transform ${groupExpanded ? 'rotate-180' : ''}`}
                      />
                    </Collapsible.Trigger>
                  </div>
                </td>
              </tr>
              <tr class="batshit-settings-table-row is-flush">
                <td colspan="2" class="batshit-settings-table-cell is-flush">
                  <Collapsible.Content class="overflow-hidden">
                    <table class="w-full min-w-[520px] table-fixed text-xs">
                      <colgroup>
                        <col class="w-[420px]" />
                        <col class="w-[100px]" />
                      </colgroup>
                      <tbody>
                        {#each group.tools as tool (tool.id)}
                          <tr class="batshit-settings-table-row is-l3">
                            <td class="batshit-settings-table-cell is-muted is-nested">
                              <span
                                class="batshit-settings-tool-grid-name block truncate font-mono text-[11px]"
                                title={tool.name}
                              >
                                {tool.name}
                              </span>
                            </td>
                            <td class="batshit-settings-table-cell">
                              <Switch.Root
                                checked={isToolShared(tool.id)}
                                onCheckedChange={(checked) => setToolShared(tool.id, checked === true)}
                              />
                            </td>
                          </tr>
                        {/each}
                        {#if group.tools.length === 0}
                          <tr class="batshit-settings-table-row">
                            <td colspan="2" class="batshit-settings-table-cell is-muted is-nested">
                              No tools discovered in this group.
                            </td>
                          </tr>
                        {/if}
                      </tbody>
                    </table>
                  </Collapsible.Content>
                </td>
              </tr>
            </Collapsible.Root>
          {/each}
                    </tbody>
                  </table>
                </Collapsible.Content>
              </td>
            </tr>
          </Collapsible.Root>
        {/each}

        <ShareRowsSection
          sectionKey="__group_other_tools__"
          title="Other"
          sectionIconRef={TOOL_GRID_OTHER_SECTION_ICON_REF}
          typeLabel="Other Tool"
          rows={otherRows}
          open={openTopLevelAccordionItemKey === '__group_other_tools__'}
          {topLevelAccordionRowClass}
          {isToolShared}
          {setToolShared}
          {setManyShared}
          onHeaderClick={handleTopLevelHeaderClick}
          onToggle={toggleTopLevelAccordionItem}
          flattenSingleRow
        />
      </tbody>
    </table>
  </div>
{/if}
