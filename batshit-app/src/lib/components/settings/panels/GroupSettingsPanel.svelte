<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import * as Card from '$lib/components/ui/card'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import {
    AlertCircle,
    ChevronDown,
    Grid3X3,
    Loader2,
    Pencil,
    Plus,
    RefreshCcw,
    Trash2,
    UploadCloud
  } from '@lucide/svelte'
  import { DEFAULT_AGENT_ICON_REF, DEFAULT_GROUP_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import {
    iconRefKey,
    normalizeAvatarIconFit,
    type AvatarIconFit,
    type IconRef
  } from '$lib/icons/iconTypes'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import GroupToolSharingGrid from '$lib/components/settings/group/GroupToolSharingGrid.svelte'
  import { GroupService } from '$lib/services/groups'
  import type { GroupChatGroupRow } from '$lib/types/database'
  import type { GroupChatAgentSettings, GroupChatSpeakPolicy } from '$lib/types/groupChat'
  import { isManagedPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
  import {
    GROUP_CHAT_MAX_FOLLOWUPS_TOTAL,
    GROUP_CHAT_SESSION_DEFAULTS,
    normalizeGroupMaxAgents,
    normalizeGroupMaxFollowupsTotal
  } from '$lib/types/groupChat'
  import * as groupStore from '$lib/stores/groups.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import * as sessionStore from '$lib/stores/session.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'

  type PanelData = {
    user?: { id: string } | null
  } | null

  interface GroupFormState {
    id: string | null
    name: string
    avatar_url: string | null
    avatar_icon_ref: IconRef
    avatar_icon_fit: AvatarIconFit
    agent_ids: string[]
    agent_settings: Record<string, GroupChatAgentSettings>
    group_system_prompt: string
    max_followups_total: number
    max_agents: number
    driver_mode: boolean
    driver_agent_id: string | null
    shared_tools: string[]
  }

  type SaveTarget = 'settings' | 'agents' | 'tools'

  const SAVE_DEBOUNCE_MS = 650
  const MAX_GROUP_AVATAR_BYTES = 5 * 1024 * 1024
  const SPEAK_POLICIES: Array<{ value: GroupChatSpeakPolicy; label: string }> = [
    { value: 'none', label: 'No preset' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'quiet', label: 'Quiet' },
    { value: 'only_when_asked', label: 'Only when asked' },
    { value: 'topic_only', label: 'Topic only' }
  ]

  const EMPTY_FORM: GroupFormState = {
    id: null,
    name: '',
    avatar_url: null,
    avatar_icon_ref: DEFAULT_GROUP_ICON_REF,
    avatar_icon_fit: 'fill',
    agent_ids: [],
    agent_settings: {},
    group_system_prompt: '',
    max_followups_total: GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5,
    max_agents: GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4,
    driver_mode: GROUP_CHAT_SESSION_DEFAULTS.driver_mode ?? false,
    driver_agent_id: GROUP_CHAT_SESSION_DEFAULTS.driver_agent_id ?? null,
    shared_tools: GROUP_CHAT_SESSION_DEFAULTS.shared_tools ?? []
  }

  let { data = null }: { data?: PanelData } = $props()

  const groupService = new GroupService()
  let groups = $state<GroupChatGroupRow[]>([])
  let listLoading = $state(true)
  let listError = $state<string | null>(null)
  let selectedGroupId = $state<string | null>(null)

  let groupForm = $state<GroupFormState>({ ...EMPTY_FORM })
  let formPersistedSignature = $state<string | null>(null)
  let formHydrating = $state(false)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let saveTarget = $state<SaveTarget>('settings')
  let createBusy = $state(false)
  let deleteBusy = $state(false)
  let deleteDisclosureOpen = $state(false)
  let groupPromptEditorOpen = $state(false)
  let toolGridRefreshNonce = $state(0)
  let groupAvatarInput = $state<HTMLInputElement | null>(null)
  let isUploadingGroupAvatar = $state(false)
  let groupAvatarError = $state<string | null>(null)

  const managedAgents = $derived(
    agentStore.getAgents().filter((agent) => {
      if (!isManagedPrimaryAgentType(normalizePrimaryAgentType(agent))) return false
      return true
    })
  )

  onMount(async () => {
    await Promise.allSettled([loadGroups(), loadAgents()])
  })

  async function loadAgents() {
    if (!data?.user?.id) return
    try {
      await agentStore.loadAgents(data.user.id)
    } catch (error) {
      console.error('Failed to load agents for group settings:', error)
      listError = error instanceof Error ? error.message : 'Failed to load agents'
    }
  }

  async function loadGroups() {
    listLoading = true
    listError = null

    try {
      const loaded = await groupService.loadGroups()
      groups.splice(0, groups.length, ...loaded)
      groupStore.setGroups(loaded)

      if (loaded.length > 0) {
        const preferred = selectedGroupId
          ? loaded.find((group) => group.id === selectedGroupId)
          : undefined
        selectGroup(preferred ?? loaded[0])
      } else {
        untrack(() => {
          selectedGroupId = null
          groupForm = { ...EMPTY_FORM }
          formPersistedSignature = null
        })
      }
    } catch (error) {
      console.error('Failed to load groups:', error)
      listError = error instanceof Error ? error.message : 'Failed to load groups'
      groups.splice(0, groups.length)
      groupStore.setGroups([])
      untrack(() => {
        selectedGroupId = null
        groupForm = { ...EMPTY_FORM }
        formPersistedSignature = null
      })
    } finally {
      listLoading = false
    }
  }

  function makeFormSignature(form: GroupFormState) {
    return JSON.stringify({
      name: form.name,
      avatar_url: form.avatar_url,
      avatar_icon_ref: iconRefKey(form.avatar_icon_ref),
      avatar_icon_fit: form.avatar_icon_fit,
      agent_ids: form.agent_ids,
      agent_settings: form.agent_settings,
      group_system_prompt: form.group_system_prompt,
      max_followups_total: form.max_followups_total,
      max_agents: form.max_agents,
      driver_mode: form.driver_mode,
      driver_agent_id: form.driver_agent_id,
      shared_tools: form.shared_tools
    })
  }

  function normalizeGroup(group: GroupChatGroupRow): GroupFormState {
    return {
      id: group.id,
      name: group.name ?? '',
      avatar_url: group.avatar_url ?? null,
      avatar_icon_ref: normalizeIconRef(group.avatar_icon_ref, DEFAULT_GROUP_ICON_REF),
      avatar_icon_fit: normalizeAvatarIconFit(group.avatar_icon_fit),
      agent_ids: Array.isArray(group.agent_ids) ? group.agent_ids : [],
      agent_settings:
        group.agent_settings && typeof group.agent_settings === 'object'
          ? group.agent_settings
          : {},
      group_system_prompt: group.group_system_prompt ?? '',
      max_followups_total: normalizeGroupMaxFollowupsTotal(
        group.max_followups_total,
        GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5
      ),
      max_agents: normalizeGroupMaxAgents(
        group.max_agents,
        GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
      ),
      driver_mode:
        typeof group.driver_mode === 'boolean'
          ? group.driver_mode
          : GROUP_CHAT_SESSION_DEFAULTS.driver_mode ?? false,
      driver_agent_id:
        typeof group.driver_agent_id === 'string'
          ? group.driver_agent_id
          : GROUP_CHAT_SESSION_DEFAULTS.driver_agent_id ?? null,
      shared_tools: Array.from(
        new Set(
          (
            Array.isArray(group.shared_tools)
              ? group.shared_tools
              : Array.isArray(group.zip_settings?.shared_tools)
                ? group.zip_settings.shared_tools
                : GROUP_CHAT_SESSION_DEFAULTS.shared_tools ?? []
          )
            .map((toolName) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter(Boolean)
        )
      )
    }
  }

  function selectGroup(group: GroupChatGroupRow) {
    formHydrating = true
    untrack(() => {
      selectedGroupId = group.id
      groupForm = normalizeGroup(group)
      formPersistedSignature = makeFormSignature(groupForm)
      saveError = null
      groupAvatarError = null
      saveState = 'idle'
      saveTarget = 'settings'
    })
    formHydrating = false
  }

  function buildGroupPayload(nextForm: GroupFormState): Partial<GroupChatGroupRow> {
    return {
      name: nextForm.name.trim() || 'Untitled Group',
      avatar_url: nextForm.avatar_url?.trim() || null,
      avatar_icon_ref: nextForm.avatar_icon_ref,
      avatar_icon_fit: nextForm.avatar_icon_fit,
      agent_ids: nextForm.agent_ids,
      agent_settings: nextForm.agent_settings,
      group_system_prompt: nextForm.group_system_prompt.trim() || undefined,
      max_followups_total: nextForm.max_followups_total,
      max_agents: nextForm.max_agents,
      driver_mode: nextForm.driver_mode,
      driver_agent_id: nextForm.driver_agent_id,
      shared_tools: nextForm.shared_tools
    }
  }

  async function persistGroupForm(nextForm: GroupFormState) {
    if (!selectedGroupId) return

    const signature = makeFormSignature(nextForm)
    if (signature === formPersistedSignature) return

    const payload = buildGroupPayload(nextForm)
    await groupService.updateGroup(selectedGroupId, payload)

    formPersistedSignature = signature
    groupForm = { ...nextForm }
    saveState = 'saved'

    groupStore.updateGroup(selectedGroupId, payload)

    const idx = groups.findIndex((group) => group.id === selectedGroupId)
    if (idx !== -1) {
      groups[idx] = {
        ...groups[idx],
        ...payload
      }
    }

    setTimeout(() => {
      if (saveState === 'saved') saveState = 'idle'
    }, 1200)
  }

  const debouncedSave = debounce(async (nextForm: GroupFormState) => {
    if (!selectedGroupId) return
    if (makeFormSignature(nextForm) === formPersistedSignature) return

    saveState = 'saving'
    saveError = null

    try {
      await persistGroupForm(nextForm)
    } catch (error) {
      console.error('Failed to save group:', error)
      saveError = error instanceof Error ? error.message : 'Failed to save group'
      saveState = 'idle'
    }
  }, SAVE_DEBOUNCE_MS)

  async function saveGroupPromptFromEditor(nextPrompt: string) {
    if (!selectedGroupId) return

    saveTarget = 'settings'
    const nextForm = {
      ...groupForm,
      group_system_prompt: nextPrompt
    }

    saveState = 'saving'
    saveError = null

    try {
      await persistGroupForm(nextForm)
    } catch (error) {
      console.error('Failed to save group prompt:', error)
      saveError = error instanceof Error ? error.message : 'Failed to save group prompt'
      saveState = 'idle'
      throw error
    }
  }

  function updateForm(patch: Partial<GroupFormState>, target: SaveTarget = 'settings') {
    saveTarget = target
    groupForm = { ...groupForm, ...patch }
    if (formHydrating || !selectedGroupId) return
    debouncedSave(groupForm)
  }

  function getSaveStatusProps(target: SaveTarget) {
    if (saveTarget !== target) {
      return {
        state: 'idle' as const,
        error: null as string | null
      }
    }

    return {
      state: (saveError ? 'error' : saveState) as 'idle' | 'saving' | 'saved' | 'error',
      error: saveError
    }
  }

  function refreshToolSharingGrid() {
    toolGridRefreshNonce += 1
  }

  async function handleCreateGroup() {
    if (!data?.user?.id) {
      toast.error('User not authenticated')
      return
    }
    createBusy = true
    try {
      const created = await groupService.createGroup({
        name: 'New Group',
        agent_ids: [],
        agent_settings: {},
        max_followups_total: GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5,
        max_agents: GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4,
        driver_mode: GROUP_CHAT_SESSION_DEFAULTS.driver_mode ?? false,
        driver_agent_id: GROUP_CHAT_SESSION_DEFAULTS.driver_agent_id ?? null,
        shared_tools: GROUP_CHAT_SESSION_DEFAULTS.shared_tools ?? [],
        group_system_prompt: '',
        avatar_icon_ref: DEFAULT_GROUP_ICON_REF,
        avatar_icon_fit: 'fill'
      })
      groups.unshift(created)
      groupStore.addGroup(created)
      selectGroup(created)
    } catch (error) {
      console.error('Failed to create group:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to create group')
    } finally {
      createBusy = false
    }
  }

  async function handleDeleteGroup() {
    if (!selectedGroupId) return
    const groupName = groupForm.name?.trim() || 'this group'
    const confirmed = await confirmDialog({
      title: groupName === 'this group' ? 'Delete this group?' : `Delete "${groupName}"?`,
      description:
        'This permanently removes the group configuration. Existing chat history is preserved.',
      confirmLabel: 'Delete Group',
      tone: 'destructive'
    })
    if (!confirmed) return

    deleteBusy = true
    try {
      const result = await groupService.deleteGroup(selectedGroupId)
      groupStore.deleteGroup(selectedGroupId)
      for (const sessionId of result.clearedSessionIds) {
        const session = sessionStore.getSessions().find((entry) => entry.id === sessionId)
        if (!session) continue
        const metadata =
          session.metadata && typeof session.metadata === 'object'
            ? { ...session.metadata }
            : {}
        delete metadata.group_chat
        sessionStore.updateSession(sessionId, { metadata })
      }
      const nextGroups = groups.filter((group) => group.id !== selectedGroupId)
      groups.splice(0, groups.length, ...nextGroups)
      if (nextGroups.length > 0) {
        selectGroup(nextGroups[0])
      } else {
        selectedGroupId = null
        groupForm = { ...EMPTY_FORM }
        formPersistedSignature = null
      }
    } catch (error) {
      console.error('Failed to delete group:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete group')
    } finally {
      deleteBusy = false
    }
  }

  function toggleAgent(agentId: string) {
    const current = new Set(groupForm.agent_ids)
    if (current.has(agentId)) {
      current.delete(agentId)
    } else {
      const maxAgents = groupForm.max_agents ?? GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
      if (current.size >= maxAgents) {
        toast.error(`Groups are limited to ${maxAgents} agents for now`)
        return
      }
      current.add(agentId)
    }

    const agent_ids = Array.from(current)
    const nextSettings = { ...groupForm.agent_settings }
    if (!agent_ids.includes(agentId)) {
      delete nextSettings[agentId]
    }

    const nextDriver =
      groupForm.driver_agent_id && agent_ids.includes(groupForm.driver_agent_id)
        ? groupForm.driver_agent_id
        : agent_ids[0] ?? null

    updateForm(
      {
        agent_ids,
        agent_settings: nextSettings,
        driver_agent_id: groupForm.driver_mode ? nextDriver : groupForm.driver_agent_id
      },
      'agents'
    )
  }

  function updateAgentSettings(agentId: string, patch: Partial<GroupChatAgentSettings>) {
    const existing = groupForm.agent_settings?.[agentId] || {}
    const nextSettings = {
      ...(groupForm.agent_settings || {}),
      [agentId]: {
        ...existing,
        ...patch
      }
    }

    updateForm({ agent_settings: nextSettings }, 'agents')
  }

  function getAgentSettings(agentId: string): GroupChatAgentSettings {
    return groupForm.agent_settings?.[agentId] || { speak_policy: 'balanced' }
  }

  function getAgentName(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return agent?.displayName || agentId
  }

  function getAgentAvatarUrl(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return agent?.avatar_url ?? agent?.avatar ?? null
  }

  function getAgentAvatarIconRef(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return agent?.avatar_icon_ref ? normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF) : null
  }

  function getAgentAvatarIconFit(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return normalizeAvatarIconFit(agent?.avatar_icon_fit)
  }

  function getGroupAvatarUrl(group: { avatar_url?: string | null }) {
    return typeof group.avatar_url === 'string' && group.avatar_url.trim().length > 0
      ? group.avatar_url
      : null
  }

  function getGroupAvatarIconRef(group: { avatar_icon_ref?: unknown }) {
    return normalizeIconRef(group.avatar_icon_ref, DEFAULT_GROUP_ICON_REF)
  }

  function getGroupAvatarIconFit(group: { avatar_icon_fit?: unknown }) {
    return normalizeAvatarIconFit(group.avatar_icon_fit)
  }

  function getGroupInitials(name: string) {
    const safeName = name.trim() || 'Group'
    return safeName
      .split(/\s+/)
      .map((word) => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  function getAgentModelProvider(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return agent?.primary_model_provider ?? ''
  }

  function getAgentModelName(agentId: string) {
    const agent = managedAgents.find((item) => item.id === agentId)
    return agent?.primary_model_name ?? ''
  }

  function formatAgentModelLabel(agentId: string) {
    const provider = getAgentModelProvider(agentId)
    const modelName = getAgentModelName(agentId)

    if (!modelName && !provider) return 'Model not set'
    if (!modelName) return provider
    if (!provider) return modelName
    return `${provider}/${modelName}`
  }

  function getSidebarAgentIds(group: GroupChatGroupRow) {
    if (!Array.isArray(group.agent_ids)) return []
    return group.agent_ids.slice(0, 3)
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json()
      if (typeof data?.error === 'string' && data.error.trim().length > 0) {
        return data.error.trim()
      }
      if (typeof data?.details === 'string' && data.details.trim().length > 0) {
        return data.details.trim()
      }
    } catch {
      // Ignore parse errors and fall back below.
    }
    return fallback
  }

  async function handleGroupAvatarUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement | null
    const file = input?.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      groupAvatarError = 'Please choose an image file'
      if (input) input.value = ''
      return
    }

    if (file.size > MAX_GROUP_AVATAR_BYTES) {
      groupAvatarError = 'Avatar must be 5MB or smaller'
      if (input) input.value = ''
      return
    }

    if (!selectedGroupId) {
      groupAvatarError = 'Select a group before uploading an avatar'
      if (input) input.value = ''
      return
    }

    isUploadingGroupAvatar = true
    groupAvatarError = null

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('entityType', 'group')
      formData.append('entityId', selectedGroupId)
      if (groupForm.avatar_url) {
        formData.append('oldAvatarUrl', groupForm.avatar_url)
      }

      const uploadResponse = await fetch('/api/uploads/avatar', {
        method: 'POST',
        body: formData
      })

      if (!uploadResponse.ok) {
        const message = await extractError(uploadResponse, 'Failed to upload avatar')
        throw new Error(message)
      }

      const result = await uploadResponse.json()
      const url = result?.url ?? ''
      if (!url) {
        throw new Error('Upload succeeded but no avatar URL was returned')
      }

      updateForm({ avatar_url: url }, 'settings')
    } catch (error) {
      console.error('Group avatar upload failed:', error)
      groupAvatarError = error instanceof Error ? error.message : 'Failed to upload avatar'
    } finally {
      isUploadingGroupAvatar = false
      if (input) input.value = ''
    }
  }

  function clearGroupAvatar() {
    groupAvatarError = null
    updateForm({ avatar_url: null }, 'settings')
  }

  function chooseGroupAvatarIcon(iconRef: IconRef) {
    groupAvatarError = null
    updateForm(
      {
        avatar_url: null,
        avatar_icon_ref: iconRef,
        avatar_icon_fit: 'fill'
      },
      'settings'
    )
  }

  $effect(() => {
    if (!groupForm.driver_mode) return
    if (groupForm.agent_ids.length === 0) return
    const driverId = groupForm.driver_agent_id
    if (!driverId || !groupForm.agent_ids.includes(driverId)) {
      updateForm({ driver_agent_id: groupForm.agent_ids[0] }, 'settings')
    }
  })

  function handleFollowupsInput(rawValue: string) {
    updateForm(
      {
        max_followups_total: normalizeGroupMaxFollowupsTotal(
          rawValue,
          groupForm.max_followups_total ?? GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5
        )
      },
      'settings'
    )
  }
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <div class="flex items-center gap-2">
        <BatshitIcon id="groups" class="h-5 w-5 text-muted-foreground" />
        <h3 class="batshit-settings-section-title">Groups</h3>
        <SettingsInfoMenu ariaLabel="About Groups">
          <p>
            Build multi-agent groups and choose them from the chat bar when you want several agents
            to collaborate in one conversation.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={loadGroups}>
        <RefreshCcw  />
        Refresh
      </Button>
      <Button size="sm" onclick={handleCreateGroup} disabled={createBusy}>
        <Plus  />
        {createBusy ? 'Creating...' : 'New Group'}
      </Button>
    </div>
  </div>

  <div class="batshit-settings-surface">
    <div class="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card.Root class="batshit-settings-card batshit-settings-card-default">
        <Card.Header class="pb-2">
          <div class="flex items-center gap-1">
            <Card.Title>Saved Groups</Card.Title>
            <SettingsInfoMenu ariaLabel="About Saved Groups">
              <p>Pick a group to edit, duplicate mentally, or use as a starting point for a new setup.</p>
            </SettingsInfoMenu>
          </div>
        </Card.Header>
        <Card.Content class="batshit-settings-card-content-flush">
          {#if listLoading}
            <div class="batshit-settings-empty-state">Loading groups...</div>
          {:else if listError}
            <div class="flex items-start gap-2 px-4 py-4 text-sm text-destructive">
              <AlertCircle class="mt-0.5 h-4 w-4" />
              <span>{listError}</span>
            </div>
          {:else if groups.length === 0}
            <div class="batshit-settings-empty-state">No groups yet.</div>
          {:else}
            <div class="settings-sidebar-items">
              {#each groups as group (group.id)}
                <button
                  type="button"
                  class="settings-sidebar-item settings-sidebar-item-with-avatar"
                  data-state={selectedGroupId === group.id ? 'active' : 'inactive'}
                  onclick={() => selectGroup(group)}
                >
                  <div class="settings-sidebar-item-media pt-0.5">
                    <EntityAvatar
                      avatarUrl={getGroupAvatarUrl(group)}
                      iconRef={getGroupAvatarIconRef(group)}
                      iconFit={getGroupAvatarIconFit(group)}
                      label={group.name || 'Group'}
                      fallback={group.name || 'Group'}
                      class="batshit-settings-avatar-frame h-10 w-10"
                      iconClass="text-muted-foreground"
                    />
                  </div>
                  <div class="settings-sidebar-item-content">
                    <span class="settings-sidebar-item-title truncate">
                      {group.name || 'Untitled Group'}
                    </span>
                    {#if getSidebarAgentIds(group).length > 0}
                      <div class="mt-2 flex items-center gap-2">
                        <div class="flex items-center -space-x-2">
                          {#each getSidebarAgentIds(group) as agentId (agentId)}
                            <EntityAvatar
                              avatarUrl={getAgentAvatarUrl(agentId)}
                              iconRef={getAgentAvatarIconRef(agentId)}
                              iconFit={getAgentAvatarIconFit(agentId)}
                              label={getAgentName(agentId)}
                              fallback={getAgentName(agentId)}
                              class="batshit-settings-avatar-frame h-6 w-6"
                              iconClass="text-muted-foreground"
                            />
                          {/each}
                        </div>
                        {#if group.agent_ids.length > 3}
                          <span class="batshit-settings-child-label">
                            +{group.agent_ids.length - 3}
                          </span>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </Card.Content>
      </Card.Root>

      <div class="space-y-4">
        {#if !selectedGroupId}
          <Card.Root class="batshit-settings-card batshit-settings-card-default">
            <Card.Header>
              <div class="flex items-center gap-1">
                <Card.Title>Select a Group</Card.Title>
                <SettingsInfoMenu ariaLabel="About Group Settings">
                  <p>
                    Configure who belongs to this group, how the first reply is handled, and which
                    tool outputs get shared across the group run.
                  </p>
                </SettingsInfoMenu>
              </div>
            </Card.Header>
            <Card.Content class="batshit-settings-card-caption">
              Create a new group to start configuring multi-agent chat.
            </Card.Content>
          </Card.Root>
        {:else}
          <SettingsAccordionCard
            name="group-settings-cards"
            title="Group Settings"
            batshitIcon="groups"
            open
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Group Settings">
                  <p>
                    Configure who belongs to this group, how the first reply is handled, and which
                    tool outputs get shared across the group run.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              <SettingsSaveStatus
                state={getSaveStatusProps('settings').state}
                error={getSaveStatusProps('settings').error}
                savedLabel="Group Settings Saved"
                sticky={false}
              />
            {/snippet}
            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label for="group-name" class="batshit-settings-form-label">Group Name</Label.Label>
                      <SettingsInfoMenu ariaLabel="About Group Name">
                        <p>
                          This is just the display name Batshit shows in the Agent Selector and anywhere
                          else groups appear in the app.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Input
                      id="group-name"
                      value={groupForm.name}
                      oninput={(event) =>
                        updateForm({ name: (event.currentTarget as HTMLInputElement).value }, 'settings')
                      }
                    />
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <p class="batshit-settings-form-label">Group System Prompt</p>
                      <SettingsInfoMenu ariaLabel="About Group System Prompt">
                        <p>
                          Shared instructions injected for every turn in this group only. Use this for
                          coordination rules that all agents in the group should follow together.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control is-compact-action">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onclick={() => (groupPromptEditorOpen = true)}
                    >
                      <Pencil aria-hidden="true" />

                      Edit
                    </Button>
                  </div>
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <p class="batshit-settings-form-label">Driver Mode</p>
                      <SettingsInfoMenu ariaLabel="About Driver Mode">
                        <p>
                          Choose one default first responder for each user turn. A direct mention in
                          the chat can still hand the turn to someone else.
                        </p>
                        <p class="mt-2">
                          One agent can lead the first reply while the rest join in after.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={groupForm.driver_mode}
                    onCheckedChange={(checked) =>
                      updateForm(
                        {
                          driver_mode: checked,
                          driver_agent_id: checked
                            ? groupForm.driver_agent_id ?? groupForm.agent_ids[0] ?? null
                            : groupForm.driver_agent_id
                        },
                        'settings'
                      )
                    }
                  />
                </div>

                {#if groupForm.driver_mode}
                  <div class="batshit-settings-form-row is-compact">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Driver Agent</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Driver Agent">
                          <p>
                            If the current driver leaves the group, Batshit automatically falls back to
                            the first remaining group member.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={groupForm.driver_agent_id ?? groupForm.agent_ids[0] ?? undefined}
                        onValueChange={(value) =>
                          updateForm(
                            {
                              driver_agent_id: Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
                            },
                            'settings'
                          )
                        }
                      >
                        <Select.Trigger class="batshit-settings-select-compact w-full">
                          <span>{getAgentName(groupForm.driver_agent_id ?? groupForm.agent_ids[0] ?? '')}</span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each groupForm.agent_ids as agentId}
                            <Select.Item value={agentId}>{getAgentName(agentId)}</Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>
                {/if}

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <p class="batshit-settings-form-label">Extra Follow-Up Turns</p>
                      <SettingsInfoMenu ariaLabel="About Extra Follow-Up Turns">
                        <p>
                          Counts extra AI turns after the first response in each group run. Use
                          <code>0</code> for unlimited follow-ups.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Input
                      type="number"
                      min="0"
                      max={GROUP_CHAT_MAX_FOLLOWUPS_TOTAL}
                      value={groupForm.max_followups_total ?? 5}
                      oninput={(event) =>
                        handleFollowupsInput((event.currentTarget as HTMLInputElement).value)
                      }
                    />
                  </div>
                </div>
              </div>

              <div class="space-y-4">
                <div class="batshit-settings-card batshit-settings-card-subtle-frame is-spacious space-y-3">
                  <div class="flex flex-col items-start gap-4">
                    <EntityAvatar
                      avatarUrl={groupForm.avatar_url}
                      iconRef={groupForm.avatar_icon_ref}
                      iconFit={groupForm.avatar_icon_fit}
                      label={groupForm.name || 'Group'}
                      fallback={groupForm.name || 'Group'}
                      class="batshit-settings-avatar-preview"
                      iconClass="text-muted-foreground"
                    />
                    <div class="w-full space-y-2">
                      <div class="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => groupAvatarInput?.click()}
                          disabled={isUploadingGroupAvatar}
                        >
                          {#if isUploadingGroupAvatar}
                            <Loader2 class="animate-spin" />
                            Uploading…
                          {:else}
                            <UploadCloud  />
                            Upload Avatar
                          {/if}
                        </Button>
                        <IconPicker
                          bind:value={groupForm.avatar_icon_ref}
                          triggerLabel="Use Icon"
                          onSelect={chooseGroupAvatarIcon}
                        />
                        {#if groupForm.avatar_url}
                          <Button
                            size="icon"
                            variant="ghost"
                            class="is-danger"
                            onclick={clearGroupAvatar}
                            disabled={isUploadingGroupAvatar}
                            title="Remove Avatar"
                            aria-label="Remove Avatar"
                          >
                            <Trash2  />
                          </Button>
                        {/if}
                      </div>
                      {#if groupAvatarError}
                        <p class="batshit-settings-form-help is-danger">{groupAvatarError}</p>
                      {/if}
                    </div>
                    <input
                      class="hidden"
                      type="file"
                      accept="image/*"
                      bind:this={groupAvatarInput}
                      onchange={handleGroupAvatarUpload}
                    />
                  </div>
                </div>
              </div>
            </div>
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="group-settings-cards"
            title="Group Agents"
            batshitIcon="agents"
            contentClass="space-y-3"
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Group Agents">
                  <p>
                    Groups currently work with Batshit-managed API and CLI agents. Add at least
                    two agents to make group chat available in the chat bar.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              <SettingsSaveStatus
                state={getSaveStatusProps('agents').state}
                error={getSaveStatusProps('agents').error}
                savingLabel="Saving group agents..."
                savedLabel="Group Agents Saved"
                sticky={false}
              />
            {/snippet}
              {#if managedAgents.length === 0}
                <div class="batshit-settings-caption">Add an API or CLI agent first.</div>
              {:else}
                <div class="space-y-2">
                  {#each managedAgents as agent (agent.id)}
                    {@const selected = groupForm.agent_ids.includes(agent.id)}
                    {@const isDriver = groupForm.driver_mode && groupForm.driver_agent_id === agent.id}
                    <div class={`batshit-settings-muted-panel transition-opacity ${selected ? 'opacity-100' : 'opacity-60'}`}>
                      <div class="flex items-start justify-between gap-3">
                        <div class="flex min-w-0 items-start gap-3">
                          <EntityAvatar
                            avatarUrl={getAgentAvatarUrl(agent.id)}
                            iconRef={getAgentAvatarIconRef(agent.id)}
                            iconFit={getAgentAvatarIconFit(agent.id)}
                            label={agent.displayName || agent.id}
                            fallback={agent.displayName || agent.id}
                            class="batshit-settings-avatar-frame h-10 w-10 shrink-0"
                            iconClass="text-muted-foreground"
                          />
                          <div class="min-w-0 flex-1">
                            <div class="batshit-settings-form-label flex min-w-0 items-center gap-2">
                              <span class="truncate">{agent.displayName || agent.id}</span>
                              {#if isDriver}
                                <span class="batshit-settings-pill is-primary shrink-0">
                                  Driver
                                </span>
                              {/if}
                            </div>
                            <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                              {#if getAgentModelName(agent.id)}
                                <ModelProviderIcon
                                  modelId={getAgentModelName(agent.id)}
                                  modelName={getAgentModelName(agent.id)}
                                  provider={getAgentModelProvider(agent.id) || 'custom'}
                                  size="sm"
                                  badgeProvider={getAgentModelProvider(agent.id) || undefined}
                                />
                              {/if}
                              <span class="truncate">{formatAgentModelLabel(agent.id)}</span>
                            </div>
                          </div>
                        </div>
                        <Switch.Root
                          checked={selected}
                          onCheckedChange={() => toggleAgent(agent.id)}
                        />
                      </div>

                      {#if selected}
                        {@const settings = getAgentSettings(agent.id)}
                        <div class="mt-3 grid gap-2 md:grid-cols-2">
                          <div class="space-y-1">
                            <Label.Label class="batshit-settings-child-label">Speaking Preset</Label.Label>
                            <Select.Root
                              type="single"
                              value={settings.speak_policy || 'balanced'}
                              onValueChange={(value) =>
                                updateAgentSettings(agent.id, {
                                  speak_policy: (
                                    Array.isArray(value) ? value[0] : value
                                  ) as GroupChatSpeakPolicy
                                })
                              }
                            >
                              <Select.Trigger class="batshit-settings-select-compact w-full">
                                <span>
                                  {SPEAK_POLICIES.find(
                                    (option) => option.value === (settings.speak_policy || 'balanced')
                                  )?.label || 'Balanced'}
                                </span>
                              </Select.Trigger>
                              <Select.Content>
                                {#each SPEAK_POLICIES as option}
                                  <Select.Item value={option.value}>{option.label}</Select.Item>
                                {/each}
                              </Select.Content>
                            </Select.Root>
                          </div>

                          {#if settings.speak_policy === 'topic_only'}
                            <div class="space-y-1">
                              <Label.Label class="batshit-settings-child-label">Topics</Label.Label>
                              <Input
                                class="h-7 text-xs"
                                placeholder="Topics (comma separated)"
                                value={(settings.speak_topics || []).join(', ')}
                                oninput={(event) =>
                                  updateAgentSettings(agent.id, {
                                    speak_topics: (event.currentTarget as HTMLInputElement)
                                      .value
                                      .split(',')
                                      .map((value) => value.trim())
                                      .filter(Boolean)
                                  })
                                }
                              />
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
              {#if groupForm.agent_ids.length < 2}
                <div class="batshit-settings-form-label">Add at least two agents to enable group chat.</div>
              {/if}
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="group-settings-cards"
            title="Group Tool Sharing Grid"
            icon={Grid3X3}
            contentClass="batshit-settings-card-content-flush"
          >
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Tool Output Sharing">
                  <p>
                    Group chat now inherits each agent&apos;s own tool and zip behavior. This section
                    only controls which tool outputs get shared back into the group.
                  </p>
                  <p class="mt-2">Use this only for cross-agent sharing rules.</p>
                </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              <div class="flex items-center justify-end gap-2">
                <Button variant="outline" size="sm" onclick={refreshToolSharingGrid}>
                  <RefreshCcw  />
                  Refresh
                </Button>
                <SettingsSaveStatus
                  state={getSaveStatusProps('tools').state}
                  error={getSaveStatusProps('tools').error}
                  savingLabel="Saving tool sharing..."
                  savedLabel="Tool Sharing Saved"
                  sticky={false}
                />
              </div>
            {/snippet}
              <GroupToolSharingGrid
                userId={data?.user?.id ?? null}
                sharedTools={groupForm.shared_tools}
                refreshNonce={toolGridRefreshNonce}
                onSharedToolsChange={(sharedTools) => updateForm({ shared_tools: sharedTools }, 'tools')}
              />
          </SettingsAccordionCard>

          <Collapsible.Root bind:open={deleteDisclosureOpen}>
            <div>
              <Collapsible.Trigger class="batshit-settings-delete-trigger">
                <span class="batshit-settings-delete-trigger-label">
                  <Trash2 class="batshit-settings-delete-trigger-icon" />
                  Delete Group
                </span>
                <ChevronDown
                  class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                />
              </Collapsible.Trigger>
              <Collapsible.Content class="batshit-settings-delete-content">
                <div class="batshit-settings-delete-content-inner">
                  <div class="batshit-settings-delete-copy">
                    <p>Permanently removes this group and its group-specific behavior settings.</p>
                    <p>Use this when you want to rebuild the group from scratch.</p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    class="batshit-settings-delete-action"
                    onclick={handleDeleteGroup}
                    disabled={deleteBusy}
                  >
                    {#if deleteBusy}
                      <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                    {:else}
                      <Trash2 class="batshit-settings-delete-action-icon" />
                    {/if}
                    Delete Group
                  </Button>
                </div>
              </Collapsible.Content>
            </div>
          </Collapsible.Root>
        {/if}
      </div>
    </div>
  </div>
</div>

<SettingsTextEditor
  bind:open={groupPromptEditorOpen}
  title="Group System Prompt"
  description="Shared instructions added to every turn for this group only."
  value={groupForm.group_system_prompt}
  placeholder="Applies to all agents in this group only."
  width="large"
  saveLabel="Save Prompt"
  onSave={saveGroupPromptFromEditor}
/>
