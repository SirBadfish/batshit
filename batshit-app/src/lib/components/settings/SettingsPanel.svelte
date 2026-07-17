<script lang="ts">
import { onMount } from 'svelte'
import type { Component } from 'svelte'
import {
  AudioLines,
  Code2,
  KeyRound,
  Palette,
  Paperclip,
  ShieldCheck,
  Trash2,
  User,
  Wrench,
  X
} from '@lucide/svelte'
import * as Sheet from '$lib/components/ui/sheet'
import * as Tabs from '$lib/components/ui/tabs'
import * as Dialog from '$lib/components/ui/dialog'
import { Tabs as TabsPrimitive } from 'bits-ui'
import { Button } from '$lib/components/ui/button'
import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
import LazySettingsPanelContent from './LazySettingsPanelContent.svelte'
import { BATSHIT_SETTINGS_PANEL_OPEN_CLASS } from '$lib/components/ui/sonner/toast-scope'
import type { UserSettingsRow } from '$lib/types/database'

type SettingsPanelData = {
  user?: {
    id: string
    email?: string | null
    is_admin?: boolean
  } | null
  userSettings?: UserSettingsRow | null
  internalDevPanelEnabled?: boolean
} | null

interface Props {
  open?: boolean
  initialTab?: string | null
  initialAgentId?: string | null
  initialModelId?: string | null
  initialToolsTab?: 'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options' | null
  initialArtifactId?: string | null
  initialAdminSection?: 'diagnostics' | null
  initialDiagnosticsAction?: 'preview' | null
  initialAdminSectionNonce?: number
  initialProjectsMode?: 'list' | 'create' | null
  initialProjectsModeNonce?: number
  data?: SettingsPanelData
}

type GoonsUnsavedState = {
  message: string
  saveLabel: string
  onSave: () => Promise<boolean>
  onDiscard: () => void
}

type PendingSettingsAction =
  | { type: 'switch-tab'; nextTab: string }
  | { type: 'close-sheet' }
  | null

let {
  open = $bindable(false),
  initialTab = 'agents',
  initialAgentId: _initialAgentId = null,
  initialModelId: _initialModelId = null,
  initialToolsTab = null,
  initialArtifactId: _initialArtifactId = null,
  initialAdminSection = null,
  initialDiagnosticsAction = null,
  initialAdminSectionNonce = 0,
  initialProjectsMode = null,
  initialProjectsModeNonce = 0,
  data = null
}: Props = $props()

function normalizeInitialTab(value?: string | null) {
  if (value === 'mcp') return 'tools'
  if (value === 'zips') return 'tools'
  if (value === 'portable-skills') return 'slash-commands'
  return value ?? 'agents'
}

function normalizeInitialToolsTab(
  tab?: string | null,
  toolsTab?: 'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options' | null
) {
  if (
    toolsTab === 'gateway-settings' ||
    toolsTab === 'cli-tools' ||
    toolsTab === 'tool-grid' ||
    toolsTab === 'zip-options'
  ) {
    return toolsTab
  }
  if (tab === 'zips') return 'zip-options'
  if (tab === 'mcp') return 'tool-grid'
  return 'gateway-settings'
}

let activeTab = $state('agents')
let wasOpen = $state(false)
let settingsOpenEventWasOpen = $state(false)
let lastInitialTab = $state('agents')
let activeToolsTab = $state<'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options'>('gateway-settings')
let lastInitialToolsTab = $state<'gateway-settings' | 'cli-tools' | 'tool-grid' | 'zip-options'>('gateway-settings')
let isOverlayVisible = $state(false)
let goonsUnsavedState = $state<GoonsUnsavedState | null>(null)
let settingsUnsavedDialogOpen = $state(false)
let pendingSettingsAction = $state<PendingSettingsAction>(null)

function showOverlay() {
  isOverlayVisible = true
}

function hideOverlay(event?: FocusEvent) {
  if (event) {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(next)) {
      return
    }
  }
  isOverlayVisible = false
}

function setGoonsUnsavedState(state: GoonsUnsavedState | null) {
  goonsUnsavedState = state
}

function hasBlockingGoonsChanges() {
  return activeTab === '3d-goons' && Boolean(goonsUnsavedState)
}

function queueSettingsAction(action: PendingSettingsAction) {
  pendingSettingsAction = action
  settingsUnsavedDialogOpen = true
}

function clearPendingSettingsAction() {
  settingsUnsavedDialogOpen = false
  pendingSettingsAction = null
}

function runPendingSettingsAction() {
  const action = pendingSettingsAction
  clearPendingSettingsAction()
  if (!action) return
  if (action.type === 'switch-tab') {
    activeTab = action.nextTab
    return
  }
  open = false
}

async function saveGoonsChangesAndContinue() {
  if (!goonsUnsavedState) return
  const saved = await goonsUnsavedState.onSave()
  if (!saved) return
  runPendingSettingsAction()
}

function discardGoonsChangesAndContinue() {
  if (!goonsUnsavedState) return
  goonsUnsavedState.onDiscard()
  runPendingSettingsAction()
}

function handleSettingsTabChange(nextTab: string) {
  if (nextTab === activeTab) return
  if (hasBlockingGoonsChanges()) {
    queueSettingsAction({ type: 'switch-tab', nextTab })
    return
  }
  activeTab = nextTab
}

function handleSettingsOpenChange(nextOpen: boolean) {
  if (nextOpen) {
    open = true
    return
  }
  if (hasBlockingGoonsChanges()) {
    queueSettingsAction({ type: 'close-sheet' })
    return
  }
  open = false
}

function handleSettingsInteractOutside(event: PointerEvent) {
  const target = event.target
  if (target instanceof Element && target.closest('.toaster')) {
    event.preventDefault()
  }
}

type IconComponent = typeof User
type PanelLoader = () => Promise<{ default: Component<any> }>

type TabIcon =
  | { type: 'lucide'; component: IconComponent }
  | { type: 'batshit'; id: string }
  | { type: 'asset'; src: string; class?: string }

type ComponentTabContent = {
  kind: 'component'
  loader: PanelLoader
  props?: () => Record<string, unknown>
}

type PlaceholderTabContent = {
  kind: 'placeholder'
  title: string
  body: string[]
}

type TabContent = ComponentTabContent | PlaceholderTabContent

function resolvePanelProps(content: ComponentTabContent) {
  return content.props ? content.props() : {}
}

function resolveGoonsPanelProps(content: ComponentTabContent) {
  return {
    ...resolvePanelProps(content),
    onUnsavedStateChange: setGoonsUnsavedState,
    active: true
  }
}

interface TabDefinition {
  value: string
  label: string
  section: number
  icon: TabIcon
  content: TabContent
}

const tabs: TabDefinition[] = [
  {
    value: 'agents',
    label: 'Agents',
    section: 1,
    icon: { type: 'batshit', id: 'agents' },
    content: {
      kind: 'component',
      loader: () => import('./panels/AgentSettingsPanel.svelte'),
      props: () => ({ data, initialAgentId: _initialAgentId })
    }
  },
  {
    value: 'groups',
    label: 'Groups',
    section: 1,
    icon: { type: 'batshit', id: 'groups' },
    content: { kind: 'component', loader: () => import('./panels/GroupSettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: 'models',
    label: 'Models',
    section: 1,
    icon: { type: 'batshit', id: 'models' },
    content: {
      kind: 'component',
      loader: () => import('./panels/ModelSettingsPanel.svelte'),
      props: () => ({ data, initialModelId: _initialModelId, active: open && activeTab === 'models' })
    }
  },
  {
    value: 'projects',
    label: 'Projects',
    section: 1,
    icon: { type: 'batshit', id: 'projects' },
    content: {
      kind: 'component',
      loader: () => import('./panels/ProjectsSettingsPanel.svelte'),
      props: () => ({
        data,
        initialMode: initialProjectsMode,
        initialModeNonce: initialProjectsModeNonce
      })
    }
  },
  {
    value: 'tools',
    label: 'Tools',
    section: 2,
    icon: { type: 'lucide', component: Wrench },
    content: {
      kind: 'component',
      loader: () => import('./panels/MCPSettingsPanel.svelte'),
      props: () => ({ data, mode: 'panel', initialToolsTab: activeToolsTab })
    }
  },
  {
    value: 'artifacts',
    label: 'Artifacts',
    section: 2,
    icon: { type: 'batshit', id: 'artifacts' },
    content: {
      kind: 'component',
      loader: () => import('./panels/ArtifactSettingsPanel.svelte'),
      props: () => ({ data, initialArtifactId: _initialArtifactId })
    }
  },
  {
    value: 'slash-commands',
    label: 'Skills & Prompts',
    section: 2,
    icon: { type: 'batshit', id: 'skills' },
    content: { kind: 'component', loader: () => import('./panels/SlashCommandSettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: '3d-goons',
    label: '3D Goons',
    section: 3,
    icon: { type: 'batshit', id: 'goons' },
    content: { kind: 'component', loader: () => import('./panels/GoonsSettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: 'voice',
    label: 'Voice',
    section: 3,
    icon: { type: 'lucide', component: AudioLines },
    content: { kind: 'component', loader: () => import('./panels/VoiceSettingsPanel.svelte') }
  },
  {
    value: 'icons',
    label: 'Icons',
    section: 3,
    icon: { type: 'batshit', id: 'icons' },
    content: { kind: 'component', loader: () => import('./panels/IconSettingsPanel.svelte') }
  },
  {
    value: 'theme',
    label: 'Themes',
    section: 3,
    icon: { type: 'lucide', component: Palette },
    content: {
      kind: 'placeholder',
      title: 'Theme Controls In Progress',
      body: [
        'Theme customization will manage palettes, typography presets, and layout accents.',
        'The tab scaffolding lives here so future stories can wire in the designer-friendly UI.'
      ]
    }
  },
  {
    value: 'clips',
    label: 'Clips',
    section: 4,
    icon: { type: 'lucide', component: Paperclip },
    content: { kind: 'component', loader: () => import('./panels/ClipSettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: 'local-ai',
    label: 'Local AI',
    section: 4,
    icon: { type: 'batshit', id: 'local-ai' },
    content: { kind: 'component', loader: () => import('./panels/LocalAISettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: 'api-keys',
    label: 'API Keys',
    section: 4,
    icon: { type: 'lucide', component: KeyRound },
    content: { kind: 'component', loader: () => import('./panels/ApiKeysSettingsPanel.svelte') }
  },
  {
    value: 'admin',
    label: 'Admin',
    section: 4,
    icon: { type: 'lucide', component: ShieldCheck },
    content: {
      kind: 'component',
      loader: () => import('./panels/AdminSettingsPanel.svelte'),
      props: () => ({
        data,
        initialSection: initialAdminSection,
        initialAction: initialDiagnosticsAction,
        initialSectionNonce: initialAdminSectionNonce
      })
    }
  },
  {
    value: 'dev',
    label: 'Dev',
    section: 4,
    icon: { type: 'lucide', component: Code2 },
    content: { kind: 'component', loader: () => import('./panels/DevSettingsPanel.svelte'), props: () => ({ data }) }
  },
  {
    value: 'user',
    label: 'User',
    section: 5,
    icon: { type: 'lucide', component: User },
    content: { kind: 'component', loader: () => import('./panels/UserSettingsPanel.svelte'), props: () => ({ data }) }
  }
]

const isDevTabVisible = $derived.by(() => {
  if (!data?.user?.is_admin) return false
  return data?.internalDevPanelEnabled === true
})
const visibleTabs = $derived.by(() =>
  tabs.filter((tab) => tab.value !== 'dev' || isDevTabVisible)
)
const visibleTabSections = $derived.by(() => {
  const sections = new Map<number, TabDefinition[]>()

  for (const tab of visibleTabs) {
    const existing = sections.get(tab.section)
    if (existing) {
      existing.push(tab)
    } else {
      sections.set(tab.section, [tab])
    }
  }

  return Array.from(sections.entries())
    .sort(([a], [b]) => a - b)
    .map(([, sectionTabs]) => sectionTabs)
})

onMount(() => {
  if (initialTab) {
    activeTab = normalizeInitialTab(initialTab)
    lastInitialTab = normalizeInitialTab(initialTab)
  }
})

$effect(() => {
  if (typeof window !== 'undefined' && open && !settingsOpenEventWasOpen) {
    window.dispatchEvent(new CustomEvent('batshit:settings-opened'))
  }
  settingsOpenEventWasOpen = open
})

$effect(() => {
  const currentInitial = normalizeInitialTab(initialTab)
  const currentInitialToolsTab = normalizeInitialToolsTab(initialTab, initialToolsTab)

  // When the sheet opens or the desired tab changes while open, sync to that tab.
  if (
    (open && !wasOpen) ||
    (open && (currentInitial !== lastInitialTab || currentInitialToolsTab !== lastInitialToolsTab))
  ) {
    activeTab = currentInitial
    activeToolsTab = currentInitialToolsTab
  }

  wasOpen = open
  lastInitialTab = currentInitial
  lastInitialToolsTab = currentInitialToolsTab

  if (!isDevTabVisible && activeTab === 'dev') {
    activeTab = 'user'
  }
})

$effect(() => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(BATSHIT_SETTINGS_PANEL_OPEN_CLASS, open)

  return () => {
    document.documentElement.classList.remove(BATSHIT_SETTINGS_PANEL_OPEN_CLASS)
  }
})

</script>

<Sheet.Root {open} onOpenChange={handleSettingsOpenChange}>
  <Sheet.Content
    side="left"
    showCloseButton={false}
    class="batshit-settings-sheet overflow-hidden flex flex-col gap-0 !w-full !max-w-full sm:!max-w-full lg:!max-w-none"
    onInteractOutside={handleSettingsInteractOutside}
    style="z-index: var(--z-overlay);"
  >
    <!-- Mobile close button (keep in corner for <768px) -->
    <button
      type="button"
      class="batshit-settings-mobile-close md:hidden absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      aria-label="Close settings"
      onclick={() => handleSettingsOpenChange(false)}
    >
      <span class="sr-only">Close</span>
      ✕
    </button>

    <Sheet.Header class="sr-only">
      <Sheet.Title>Settings</Sheet.Title>
    </Sheet.Header>

    <form
      id="batshit-settings-form"
      class="batshit-settings-form flex flex-col gap-0 min-h-0"
      onsubmit={(event) => event.preventDefault()}
    >
      <Tabs.Root value={activeTab} onValueChange={handleSettingsTabChange} class="batshit-settings-tabs flex flex-col gap-0 min-h-0">
      <!-- Mobile grid (below 768px) -->
      <h5 class="batshit-settings-mobile-title md:hidden text-center">SETTINGS</h5>
      <TabsPrimitive.List class="batshit-settings-mobile-grid relative z-[var(--z-surface)] p-2 grid w-full grid-cols-2 gap-2 sm:grid-cols-3 md:hidden">
        {#each visibleTabSections as section, sectionIndex}
          <div class="col-span-full grid grid-cols-2 gap-2 sm:grid-cols-3">
            {#each section as tab}
              <TabsPrimitive.Trigger
                value={tab.value}
                class="batshit-settings-mobile-tab inline-flex w-full items-center gap-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span class="batshit-settings-nav-icon inline-flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                  {#if tab.icon.type === 'lucide'}
                    {@const Icon = tab.icon.component}
                    <Icon class="size-5" />
                  {:else if tab.icon.type === 'batshit'}
                    <BatshitIcon id={tab.icon.id} class="size-5" />
                  {:else}
                    <img src={tab.icon.src} alt="" class={`size-5 ${tab.icon.class ?? ''}`} />
                  {/if}
                </span>
                <span>{tab.label}</span>
              </TabsPrimitive.Trigger>
            {/each}
          </div>
          {#if sectionIndex < visibleTabSections.length - 1}
            <div class="col-span-full my-1 h-px bg-border/70" aria-hidden="true"></div>
          {/if}
        {/each}
      </TabsPrimitive.List>

      <div class="batshit-settings-main flex flex-col md:flex-row">
        <!-- Icon rail for medium breakpoints (768px - 991px) -->
        <div
          class="relative hidden w-[72px] self-stretch md:flex lg:hidden md:items-start md:sticky md:top-0 md:max-h-screen md:min-h-screen z-[var(--z-surface)]"
          data-testid="settings-icon-rail"
          role="presentation"
          onmouseenter={showOverlay}
          onmouseleave={() => hideOverlay()}
          onfocusin={showOverlay}
          onfocusout={hideOverlay}
        >
          <TabsPrimitive.List class="batshit-settings-icon-rail flex w-[72px] flex-col gap-2 border px-2 pt-12 pb-2 text-sm md:max-h-screen md:min-h-screen overflow-y-auto">
            {#each visibleTabSections as section, sectionIndex}
              {#each section as tab}
                <TabsPrimitive.Trigger
                  value={tab.value}
                  class="batshit-settings-rail-item inline-flex items-center justify-start gap-2 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <span class="batshit-settings-nav-icon inline-flex size-5 items-center justify-center" aria-hidden="true">
                    {#if tab.icon.type === 'lucide'}
                      {@const Icon = tab.icon.component}
                      <Icon class="size-5" />
                    {:else if tab.icon.type === 'batshit'}
                      <BatshitIcon id={tab.icon.id} class="size-5" />
                    {:else}
                      <img src={tab.icon.src} alt="" class={`size-5 ${tab.icon.class ?? ''}`} />
                    {/if}
                  </span>
                  <span class="sr-only">{tab.label}</span>
                </TabsPrimitive.Trigger>
              {/each}
              {#if sectionIndex < visibleTabSections.length - 1}
                <div class="mx-1 my-1 h-px bg-border/70" aria-hidden="true"></div>
              {/if}
            {/each}

            <!-- Mid-breakpoint close button lives in the icon rail so it's always visible -->
            <button
              type="button"
              class="batshit-settings-nav-close mt-auto mb-1 inline-flex items-center justify-center p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label="Close settings"
              onclick={() => handleSettingsOpenChange(false)}
            >
              ✕
            </button>
          </TabsPrimitive.List>

          <TabsPrimitive.List
            class={`batshit-settings-nav-overlay absolute left-[72px] top-0 z-[var(--z-controls)] flex min-h-screen max-h-screen min-w-[240px] flex-col gap-2 border px-3 pt-0 pb-3 text-sm shadow-2xl backdrop-blur transition-opacity duration-150 overflow-y-auto ${
              isOverlayVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
          >
          <div class="batshit-settings-nav-title">SETTINGS</div>
            {#each visibleTabSections as section, sectionIndex}
              {#each section as tab}
                <TabsPrimitive.Trigger
                  value={tab.value}
                  class="batshit-settings-nav-item inline-flex w-full items-center justify-start gap-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <span>{tab.label}</span>
                </TabsPrimitive.Trigger>
              {/each}
              {#if sectionIndex < visibleTabSections.length - 1}
                <div class="mx-2 my-1 h-px bg-border/70" aria-hidden="true"></div>
              {/if}
            {/each}
          </TabsPrimitive.List>
        </div>

        <!-- Full nav for large breakpoints -->
        <TabsPrimitive.List
          class="batshit-settings-nav hidden w-64 shrink-0 flex-col gap-1 border text-sm lg:flex lg:sticky lg:top-0 lg:min-h-screen lg:max-h-screen lg:overflow-y-auto"
        >
        <h5 class="batshit-settings-nav-title">SETTINGS</h5>
          {#each visibleTabSections as section, sectionIndex}
            {#each section as tab}
              <TabsPrimitive.Trigger
                value={tab.value}
                class="batshit-settings-nav-item inline-flex w-full items-center justify-start gap-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span class="batshit-settings-nav-icon inline-flex size-5 items-center justify-center">
                  {#if tab.icon.type === 'lucide'}
                    {@const Icon = tab.icon.component}
                    <Icon class="size-5" />
                  {:else if tab.icon.type === 'batshit'}
                    <BatshitIcon id={tab.icon.id} class="size-5" />
                  {:else}
                    <img src={tab.icon.src} alt="" class={`size-5 ${tab.icon.class ?? ''}`} />
                  {/if}
                </span>
                <span>{tab.label}</span>
              </TabsPrimitive.Trigger>
            {/each}
            {#if sectionIndex < visibleTabSections.length - 1}
              <div class="mx-1 my-2 h-px bg-border/70" aria-hidden="true"></div>
            {/if}
          {/each}
          <div class="mt-4">
            <button
              type="button"
              class="batshit-settings-nav-close w-full inline-flex items-center justify-center gap-2 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onclick={() => handleSettingsOpenChange(false)}
            >
              Close
            </button>
          </div>
        </TabsPrimitive.List>

        <!-- Tab Content -->
        <div class="batshit-settings-panel-wrap relative z-0 flex-1 min-w-0">
          {#each visibleTabs as tab}
            <Tabs.Content
              value={tab.value}
              class={`flex-1 bg-background ${
                tab.value === '3d-goons' ? 'overflow-hidden' : ''
              }`}
            >
              {#if tab.content.kind === 'component'}
                {#if tab.value === '3d-goons'}
                  {#if activeTab === tab.value}
                    <LazySettingsPanelContent
                      label={tab.label}
                      loader={tab.content.loader}
                      active={open && activeTab === tab.value}
                      panelProps={resolveGoonsPanelProps(tab.content)}
                    />
                  {/if}
                {:else}
                  <div class="batshit-settings-panel-stage">
                    <LazySettingsPanelContent
                      label={tab.label}
                      loader={tab.content.loader}
                      active={open && activeTab === tab.value}
                      panelProps={resolvePanelProps(tab.content)}
                    />
                  </div>
                {/if}
              {:else}
                <div class="batshit-settings-panel-stage">
                  <div class="batshit-settings-placeholder max-w-2xl space-y-2 text-sm">
                    <p class="batshit-settings-inline-strong">{tab.content.title}</p>
                    {#each tab.content.body as line}
                      <p>{line}</p>
                    {/each}
                  </div>
                </div>
              {/if}
            </Tabs.Content>
          {/each}
        </div>

      </div>
      </Tabs.Root>
    </form>
    <Dialog.Root
      open={settingsUnsavedDialogOpen}
      onOpenChange={(nextOpen) => {
        settingsUnsavedDialogOpen = nextOpen
        if (!nextOpen) {
          pendingSettingsAction = null
        }
      }}
    >
      <Dialog.Content class="bs-unsaved-dialog-content">
        <Dialog.Header>
          <Dialog.Title>Save 3D Goons changes first?</Dialog.Title>
          <Dialog.Description>
            {goonsUnsavedState?.message ?? 'You have unsaved 3D Goons changes.'} Save them before
            continuing, or discard them and keep going.
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer class="bs-unsaved-dialog-footer gap-2">
          <Button variant="outline" onclick={clearPendingSettingsAction}><X aria-hidden="true" />Stay Here</Button>
          <Button variant="outline" onclick={discardGoonsChangesAndContinue}>
            <Trash2 aria-hidden="true" />
            Discard Changes
          </Button>
          <Button onclick={saveGoonsChangesAndContinue}>
            {goonsUnsavedState ? 'Save Changes' : 'Save'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </Sheet.Content>
</Sheet.Root>
