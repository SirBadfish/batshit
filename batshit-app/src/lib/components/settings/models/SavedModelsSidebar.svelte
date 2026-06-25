<script lang="ts">
  import { ChevronDown, Loader2 } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import * as Card from '$lib/components/ui/card'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import type { SavedModel } from '$lib/types/savedModels'

  interface Props {
    isLoading: boolean
    listError: string | null
    models: SavedModel[]
    chatModels: SavedModel[]
    visualModels: SavedModel[]
    audioModels: SavedModel[]
    utilityModels: SavedModel[]
    selectedModelId: string | null
    creatingNew: boolean
    getBadgeProviderForModel: (model: SavedModel) => string
    onSelectModel: (model: SavedModel) => void
    chatSectionOpen?: boolean
    visualSectionOpen?: boolean
    audioSectionOpen?: boolean
    utilitySectionOpen?: boolean
  }

  let {
    isLoading,
    listError,
    models,
    chatModels,
    visualModels,
    audioModels,
    utilityModels,
    selectedModelId,
    creatingNew,
    getBadgeProviderForModel,
    onSelectModel,
    chatSectionOpen = $bindable(true),
    visualSectionOpen = $bindable(false),
    audioSectionOpen = $bindable(false),
    utilitySectionOpen = $bindable(false)
  }: Props = $props()
</script>

<Card.Root class="batshit-settings-card batshit-settings-card-default h-full overflow-hidden">
  <Card.Header class="space-y-2">
    <div class="flex items-center gap-2">
      <Card.Title class="flex items-center gap-2">
        <BatshitIcon id="models" class="h-4 w-4" />
        Saved Models
      </Card.Title>
      <SettingsInfoMenu ariaLabel="About Saved Models">
        <p>
          Personal presets shared across all agents. Organize them by role so the right models
          are easy to find later.
        </p>
      </SettingsInfoMenu>
    </div>
  </Card.Header>
  <Card.Content class="batshit-settings-card-content-flush">
    {#if isLoading}
      <div class="batshit-settings-empty-state flex items-center justify-center">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        Loading models…
      </div>
    {:else if listError}
      <div class="batshit-settings-inline-alert is-danger">
        {listError}
      </div>
    {:else if models.length === 0}
      <div class="batshit-settings-empty-state">
        No saved models yet. Create one to store your preferred provider and settings.
      </div>
    {:else}
      <div>
        <div class="flex flex-col pb-4">
          <div class="batshit-settings-list-band is-active">
            <Collapsible.Root bind:open={chatSectionOpen}>
              <div class="batshit-settings-list-band-row pr-2">
                <Collapsible.Trigger class="batshit-settings-list-band-trigger flex w-full flex-1 items-center justify-between">
                  <div class="batshit-settings-form-label flex items-center gap-2">
                    Chat (Agents)
                    <Badge variant="outline" class="text-[11px] font-normal">{chatModels.length}</Badge>
                  </div>
                  <ChevronDown class={`h-4 w-4 transition-transform ${chatSectionOpen ? 'rotate-180' : ''}`} />
                </Collapsible.Trigger>
                <div class="shrink-0">
                  <SettingsInfoMenu ariaLabel="About Chat Presets">
                    <p>Used for agents and the chat bar.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <Collapsible.Content>
                {#if chatModels.length === 0}
                  <div class="batshit-settings-empty-state">No chat presets yet.</div>
                {:else}
                  <div class="settings-sidebar-items">
                    {#each chatModels as model}
                      <button
                        class="settings-sidebar-item flex items-center gap-3"
                        data-state={selectedModelId === model.id && !creatingNew ? 'active' : 'inactive'}
                        onclick={() => onSelectModel(model)}
                      >
                        <ModelProviderIcon
                          modelId={model.modelId}
                          modelName={model.modelName}
                          provider={model.provider}
                          size="md"
                          badgeProvider={getBadgeProviderForModel(model)}
                        />
                        <div class="min-w-0 flex-1">
                          <span class="settings-sidebar-item-title truncate">{model.modelName}</span>
                          <span class="settings-sidebar-item-subtext batshit-model-id truncate">{model.modelId}</span>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          <div class="batshit-settings-list-band">
            <Collapsible.Root bind:open={visualSectionOpen}>
              <div class="batshit-settings-list-band-row pr-2">
                <Collapsible.Trigger class="batshit-settings-list-band-trigger flex w-full flex-1 items-center justify-between">
                  <div class="batshit-settings-form-label flex items-center gap-2">
                    Visual
                    <Badge variant="outline" class="text-[11px] font-normal">{visualModels.length}</Badge>
                  </div>
                  <ChevronDown class={`h-4 w-4 transition-transform ${visualSectionOpen ? 'rotate-180' : ''}`} />
                </Collapsible.Trigger>
                <div class="shrink-0">
                  <SettingsInfoMenu ariaLabel="About Visual Presets">
                    <p>Artifacts that generate images, video, or 3D.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <Collapsible.Content>
                {#if visualModels.length === 0}
                  <div class="batshit-settings-empty-state">No visual presets yet.</div>
                {:else}
                  <div class="settings-sidebar-items">
                    {#each visualModels as model}
                      <button
                        class="settings-sidebar-item flex items-center gap-3"
                        data-state={selectedModelId === model.id && !creatingNew ? 'active' : 'inactive'}
                        onclick={() => onSelectModel(model)}
                      >
                        <ModelProviderIcon
                          modelId={model.modelId}
                          modelName={model.modelName}
                          provider={model.provider}
                          size="md"
                          badgeProvider={getBadgeProviderForModel(model)}
                        />
                        <div class="min-w-0 flex-1">
                          <span class="settings-sidebar-item-title truncate">{model.modelName}</span>
                          <span class="settings-sidebar-item-subtext batshit-model-id truncate">{model.modelId}</span>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          <div class="batshit-settings-list-band">
            <Collapsible.Root bind:open={audioSectionOpen}>
              <div class="batshit-settings-list-band-row pr-2">
                <Collapsible.Trigger class="batshit-settings-list-band-trigger flex w-full flex-1 items-center justify-between">
                  <div class="batshit-settings-form-label flex items-center gap-2">
                    Audio
                    <Badge variant="outline" class="text-[11px] font-normal">{audioModels.length}</Badge>
                  </div>
                  <ChevronDown class={`h-4 w-4 transition-transform ${audioSectionOpen ? 'rotate-180' : ''}`} />
                </Collapsible.Trigger>
                <div class="shrink-0">
                  <SettingsInfoMenu ariaLabel="About Audio Presets">
                    <p>Speech-to-text, text-to-speech, and audio utilities.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <Collapsible.Content>
                {#if audioModels.length === 0}
                  <div class="batshit-settings-empty-state">No audio presets yet.</div>
                {:else}
                  <div class="settings-sidebar-items">
                    {#each audioModels as model}
                      <button
                        class="settings-sidebar-item flex items-center gap-3"
                        data-state={selectedModelId === model.id && !creatingNew ? 'active' : 'inactive'}
                        onclick={() => onSelectModel(model)}
                      >
                        <ModelProviderIcon
                          modelId={model.modelId}
                          modelName={model.modelName}
                          provider={model.provider}
                          size="md"
                          badgeProvider={getBadgeProviderForModel(model)}
                        />
                        <div class="min-w-0 flex-1">
                          <span class="settings-sidebar-item-title truncate">{model.modelName}</span>
                          <span class="settings-sidebar-item-subtext batshit-model-id truncate">{model.modelId}</span>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          <div class="batshit-settings-list-band">
            <Collapsible.Root bind:open={utilitySectionOpen}>
              <div class="batshit-settings-list-band-row pr-2">
                <Collapsible.Trigger class="batshit-settings-list-band-trigger flex w-full flex-1 items-center justify-between">
                  <div class="batshit-settings-form-label flex items-center gap-2">
                    Utility
                    <Badge variant="outline" class="text-[11px] font-normal">{utilityModels.length}</Badge>
                  </div>
                  <ChevronDown class={`h-4 w-4 transition-transform ${utilitySectionOpen ? 'rotate-180' : ''}`} />
                </Collapsible.Trigger>
                <div class="shrink-0">
                  <SettingsInfoMenu ariaLabel="About Utility Presets">
                    <p>Embeddings, rerankers, moderation, OCR, and other utilities.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <Collapsible.Content>
                {#if utilityModels.length === 0}
                  <div class="batshit-settings-empty-state">No utility presets yet.</div>
                {:else}
                  <div class="settings-sidebar-items">
                    {#each utilityModels as model}
                      <button
                        class="settings-sidebar-item flex items-center gap-3"
                        data-state={selectedModelId === model.id && !creatingNew ? 'active' : 'inactive'}
                        onclick={() => onSelectModel(model)}
                      >
                        <ModelProviderIcon
                          modelId={model.modelId}
                          modelName={model.modelName}
                          provider={model.provider}
                          size="md"
                          badgeProvider={getBadgeProviderForModel(model)}
                        />
                        <div class="min-w-0 flex-1">
                          <span class="settings-sidebar-item-title truncate">{model.modelName}</span>
                          <span class="settings-sidebar-item-subtext batshit-model-id truncate">{model.modelId}</span>
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>
