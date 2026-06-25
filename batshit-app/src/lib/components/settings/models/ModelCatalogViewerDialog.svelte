<script lang="ts">
  import { RefreshCcw } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import { themeStore } from '$lib/stores/theme'
  import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
  import type { ModelCapabilities } from '$lib/types/savedModels'
  import type { ThemeMode } from '$lib/types/theme'

  type CatalogViewerRole = 'all' | 'chat' | 'visual' | 'audio' | 'utility'

  interface Props {
    open?: boolean
    catalogLoading: boolean
    catalogViewerConnection?: string
    catalogViewerProvider?: string
    catalogViewerRole?: CatalogViewerRole
    catalogViewerSearch?: string
    catalogViewerLimit?: number
    catalogViewerConnectionOptions: string[]
    catalogViewerProviderOptions: string[]
    catalogViewerRows: CatalogModel[]
    catalogViewerFilteredCount: number
    catalogViewerFallbackProvider?: string | null
    connectionOptions: CatalogConnectionOption[]
    capabilities: Array<{ key: keyof ModelCapabilities; label: string }>
    formatDeveloperLabel: (developerId?: string | null) => string
    getConnectionIconMeta: (
      option: CatalogConnectionOption,
      theme: ThemeMode
    ) => { icon: string; filter: string }
    getModelConnections: (model?: CatalogModel | null) => string[]
    formatConnectionLabel: (connectionId?: string | null) => string
    formatPrice: (value?: number | null) => string | null
    catalogFeaturesToCapabilities: (features?: Record<string, any> | null) => ModelCapabilities | null
  }

  let {
    open = $bindable(false),
    catalogLoading,
    catalogViewerConnection = $bindable('all'),
    catalogViewerProvider = $bindable('all'),
    catalogViewerRole = $bindable<CatalogViewerRole>('all'),
    catalogViewerSearch = $bindable(''),
    catalogViewerLimit = $bindable(100),
    catalogViewerConnectionOptions,
    catalogViewerProviderOptions,
    catalogViewerRows,
    catalogViewerFilteredCount,
    catalogViewerFallbackProvider = null,
    connectionOptions,
    capabilities,
    formatDeveloperLabel,
    getConnectionIconMeta,
    getModelConnections,
    formatConnectionLabel,
    formatPrice,
    catalogFeaturesToCapabilities
  }: Props = $props()

  function normalizeSelectValue(value: string | string[] | undefined, fallback = 'all') {
    return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="batshit-settings-sheet batshit-settings-model-catalog-dialog max-h-[80vh] w-[min(95vw,1100px)] min-w-[min(95vw,700px)] !max-w-[min(95vw,1100px)] sm:!max-w-[min(95vw,1100px)]">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <BatshitIcon id="model-catalog" class="h-4 w-4" />
        Model Catalog Viewer
      </Dialog.Title>
      <Dialog.Description>
        Browse the shared registry with filters for providers, developers, and pricing.
      </Dialog.Description>
    </Dialog.Header>
    <div class="batshit-settings-model-catalog-dialog-body">
      <div class="flex flex-wrap gap-3">
        <div class="flex min-w-[180px] flex-col gap-1">
          <Label.Root class="batshit-settings-form-label">Providers</Label.Root>
          <Select.Root
            type="single"
            value={catalogViewerConnection}
            onValueChange={(value) => (catalogViewerConnection = normalizeSelectValue(value))}
            disabled={catalogLoading || !catalogViewerConnectionOptions.length}
          >
            <Select.Trigger class="w-full" size="sm">
              <span class="flex items-center gap-2 truncate text-left">
                {#if catalogViewerConnection !== 'all' && catalogViewerConnection !== 'none'}
                  {@const viewerConnection = connectionOptions.find((option) => option.id === catalogViewerConnection)}
                  {#if viewerConnection}
                    {@const iconMeta = getConnectionIconMeta(viewerConnection, $themeStore)}
                    <img
                      src={iconMeta.icon}
                      alt={`${viewerConnection.label} icon`}
                      class="h-4 w-4 object-contain"
                      style:filter={iconMeta.filter || null}
                    />
                  {/if}
                {/if}
                <span class="truncate">
                  {catalogViewerConnection === 'all'
                    ? 'All Providers'
                    : catalogViewerConnection === 'none'
                      ? 'No direct provider'
                      : connectionOptions.find((option) => option.id === catalogViewerConnection)?.label ??
                        catalogViewerConnection}
                </span>
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">All Providers</Select.Item>
              <Select.Item value="none">No direct provider</Select.Item>
              {#each catalogViewerConnectionOptions as connectionId}
                {@const viewerOption = connectionOptions.find((option) => option.id === connectionId)}
                {@const iconMeta = viewerOption ? getConnectionIconMeta(viewerOption, $themeStore) : null}
                <Select.Item value={connectionId}>
                  <div class="flex items-center gap-2">
                    {#if viewerOption && iconMeta}
                      <img
                        src={iconMeta.icon}
                        alt={`${viewerOption.label} icon`}
                        class="h-4 w-4 object-contain"
                        style:filter={iconMeta.filter || null}
                      />
                    {/if}
                    <span>{viewerOption?.label ?? connectionId}</span>
                  </div>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex min-w-[180px] flex-col gap-1">
          <Label.Root class="batshit-settings-form-label">Developer</Label.Root>
          <Select.Root
            type="single"
            value={catalogViewerProvider}
            onValueChange={(value) => (catalogViewerProvider = normalizeSelectValue(value))}
            disabled={catalogLoading || !catalogViewerProviderOptions.length}
          >
            <Select.Trigger class="w-full" size="sm">
              <span class="flex items-center gap-2 truncate text-left">
                {#if catalogViewerProvider !== 'all'}
                  <ModelProviderIcon
                    modelId={`${catalogViewerProvider}/preview`}
                    modelName={formatDeveloperLabel(catalogViewerProvider)}
                    provider={catalogViewerProvider}
                    size="sm"
                    showOverlay={false}
                    badgeProvider={catalogViewerFallbackProvider ?? undefined}
                  />
                {/if}
                <span class="truncate">
                  {catalogViewerProvider === 'all' ? 'All Developers' : formatDeveloperLabel(catalogViewerProvider)}
                </span>
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">All Developers</Select.Item>
              {#each catalogViewerProviderOptions as option}
                <Select.Item value={option}>
                  <div class="flex items-center gap-2">
                    <ModelProviderIcon
                      modelId={`${option}/preview`}
                      modelName={formatDeveloperLabel(option)}
                      provider={option}
                      size="sm"
                      showOverlay={false}
                      badgeProvider={catalogViewerFallbackProvider ?? undefined}
                    />
                    <span>{formatDeveloperLabel(option)}</span>
                  </div>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex min-w-[160px] flex-col gap-1">
          <Label.Root class="batshit-settings-form-label">Role</Label.Root>
          <Select.Root
            type="single"
            value={catalogViewerRole}
            onValueChange={(value) => (catalogViewerRole = normalizeSelectValue(value) as CatalogViewerRole)}
          >
            <Select.Trigger class="w-full" size="sm">
              <span class="truncate">
                {catalogViewerRole === 'all' ? 'All Roles' : catalogViewerRole}
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">All Roles</Select.Item>
              <Select.Item value="chat">chat</Select.Item>
              <Select.Item value="visual">visual</Select.Item>
              <Select.Item value="audio">audio</Select.Item>
              <Select.Item value="utility">utility</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        <div class="min-w-[220px] flex-1">
          <Label.Root class="batshit-settings-form-label">Search</Label.Root>
          <Input
            value={catalogViewerSearch}
            placeholder="Search catalog"
            oninput={(event) => (catalogViewerSearch = (event.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="batshit-settings-table-frame">
        <table class="min-w-full text-xs">
          <thead class="batshit-settings-table-head">
            <tr>
              <th class="batshit-settings-table-head-cell">Model</th>
              <th class="batshit-settings-table-head-cell">Providers</th>
              <th class="batshit-settings-table-head-cell">Input</th>
              <th class="batshit-settings-table-head-cell">Output</th>
              <th class="batshit-settings-table-head-cell">Context Window</th>
              <th class="batshit-settings-table-head-cell">Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {#if catalogViewerRows.length === 0}
              <tr>
                <td colspan="6" class="batshit-settings-table-cell is-empty">
                  No catalog entries match your filters.
                </td>
              </tr>
            {:else}
              {#each catalogViewerRows as model (model.id)}
                {@const inputPrice = formatPrice(model.pricing?.input)}
                {@const outputPrice = formatPrice(model.pricing?.output)}
                {@const rowCapabilities = catalogFeaturesToCapabilities(model.features ?? null)}
                <tr class="batshit-settings-table-row">
                  <td class="batshit-settings-table-cell">
                    <div class="flex items-center gap-2">
                      <ModelProviderIcon
                        modelId={model.id}
                        modelName={model.displayName}
                        provider={model.provider}
                        size="sm"
                        showOverlay={false}
                        badgeProvider={catalogViewerFallbackProvider ?? undefined}
                      />
                      <div class="flex flex-col">
                        <span>{model.displayName}</span>
                        <span class="batshit-settings-form-label batshit-model-id">{model.name}</span>
                      </div>
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    {#if getModelConnections(model).length}
                      <div class="flex flex-wrap gap-1">
                        {#each getModelConnections(model) as connectionId (connectionId)}
                          <Badge variant="outline" class="batshit-settings-pill">
                            {formatConnectionLabel(connectionId)}
                          </Badge>
                        {/each}
                      </div>
                    {:else}
                      <span class="batshit-settings-form-label">—</span>
                    {/if}
                  </td>
                  <td class="batshit-settings-table-cell">{inputPrice ? `$${inputPrice}/M` : '—'}</td>
                  <td class="batshit-settings-table-cell">{outputPrice ? `$${outputPrice}/M` : '—'}</td>
                  <td class="batshit-settings-table-cell">
                    {model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : '—'}
                  </td>
                  <td class="batshit-settings-table-cell">
                    {#if rowCapabilities}
                      <div class="flex flex-wrap gap-1">
                        {#each capabilities as capability (capability.key)}
                          {#if rowCapabilities[capability.key]}
                            <Badge variant="outline" class="batshit-settings-child-label">
                              {capability.label}
                            </Badge>
                          {/if}
                        {/each}
                      </div>
                    {:else}
                      <span class="batshit-settings-form-label">—</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if catalogViewerLimit < catalogViewerFilteredCount}
        <div class="flex justify-center">
          <Button
            size="sm"
            variant="outline"
            onclick={() => (catalogViewerLimit = Math.min(catalogViewerLimit + 150, catalogViewerFilteredCount))}
          >
            <RefreshCcw aria-hidden="true" />
            Load more models
          </Button>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
