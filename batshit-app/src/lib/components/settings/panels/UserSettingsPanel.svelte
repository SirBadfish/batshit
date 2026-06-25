<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import * as Card from '$lib/components/ui/card'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import { Loader2, LogOut, AlertCircle, UploadCloud, Sparkles, UserRound, Pencil, Trash2 } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import type { UserSettingsRow } from '$lib/types/database'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
  import { iconRefKey, normalizeAvatarIconFit } from '$lib/icons/iconTypes'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'

  const MAX_DISPLAY_NAME_LENGTH = 14
  const MAX_AVATAR_BYTES = 2 * 1024 * 1024
  const SAVE_DEBOUNCE_MS = 500
  const DEFAULT_USER_ICON_REF: IconRef = { kind: 'lucide', id: 'user-round' }

  type PanelData = {
    user?: {
      id: string
      email?: string | null
    } | null
    userSettings?: UserSettingsRow | null
  } | null

  type SavePayload = {
    displayName: string
    avatar_url: string | null
    avatar_icon_ref: IconRef | null
    avatar_icon_fit: AvatarIconFit
    global_custom_system_prompt?: string
  }

  let { data = null }: { data?: PanelData } = $props()

  let settings = $state<SavePayload>(normaliseSettings(null))
  let persistedSettings = $state<SavePayload | null>(null)
  let email = $state('')
  let userId = $state<string | null>(null)

  let isLoading = $state(true)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedProfileSignature = $state(makeProfileSignature(normaliseSettings(null)))
  let persistedPromptSignature = $state(makePromptSignature(normaliseSettings(null)))
  let activeSaveScope = $state<'profile' | 'prompt' | null>(null)
  let isUploadingAvatar = $state(false)
  let logoutBusy = $state(false)
  let globalPromptEditorOpen = $state(false)
  let globalPromptDraft = $state('')
  let pendingSaveTimeout: ReturnType<typeof setTimeout> | null = null
  let pendingSavePayload: SavePayload | null = null
  let suppressNextAutoSave = false

  const displayNameError = $derived(validateDisplayName(settings.displayName))

  $effect(() => {
    if (isLoading) {
      const next = normaliseSettings(data?.userSettings)
      settings = { ...next }
      persistedSettings = data?.userSettings ? { ...next } : null
      persistedProfileSignature = makeProfileSignature(next)
      persistedPromptSignature = makePromptSignature(next)
    }
    email = data?.user?.email ?? ''
    userId = data?.user?.id ?? null
  })

  onMount(async () => {
    await loadSettings()
  })

  async function persistSettings(payload: SavePayload) {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: UserSettingsRow | null = result?.settings ?? null

      untrack(() => {
        const nextPersisted = normaliseSettings(updated ?? payload)
        persistedSettings = nextPersisted
        persistedProfileSignature = makeProfileSignature(nextPersisted)
        persistedPromptSignature = makePromptSignature(nextPersisted)
        saveState = 'saved'
        saveError = null
      })

      if (updated) {
        setUserSettings(updated)
      }
    } catch (error) {
      console.error('Failed to save user settings:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save settings'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 2000)
    }
  }

  function queueDebouncedSave(payload: SavePayload) {
    pendingSavePayload = payload
    if (pendingSaveTimeout) {
      clearTimeout(pendingSaveTimeout)
    }
    pendingSaveTimeout = setTimeout(() => {
      const payloadToSave = pendingSavePayload
      pendingSavePayload = null
      pendingSaveTimeout = null
      if (payloadToSave) {
        void persistSettings(payloadToSave)
      }
    }, SAVE_DEBOUNCE_MS)
  }

  async function flushDebouncedSave(overridePayload?: SavePayload) {
    if (pendingSaveTimeout) {
      clearTimeout(pendingSaveTimeout)
      pendingSaveTimeout = null
    }

    const payloadToSave = overridePayload ?? pendingSavePayload
    pendingSavePayload = null

    if (payloadToSave) {
      await persistSettings(payloadToSave)
    }
  }

  $effect(() => {
    if (isLoading) return
    if (suppressNextAutoSave) {
      suppressNextAutoSave = false
      return
    }

    const currentPayload: SavePayload = {
      displayName: settings.displayName.trim(),
      avatar_url: settings.avatar_url ?? null,
      avatar_icon_ref: settings.avatar_icon_ref,
      avatar_icon_fit: settings.avatar_icon_fit,
      global_custom_system_prompt: settings.global_custom_system_prompt ?? ''
    }

    const previous = persistedSettings
    const hasChanges =
      !previous ||
      previous.displayName !== currentPayload.displayName ||
      (previous.avatar_url ?? null) !== (currentPayload.avatar_url ?? null) ||
      iconRefKey(previous.avatar_icon_ref) !== iconRefKey(currentPayload.avatar_icon_ref) ||
      previous.avatar_icon_fit !== currentPayload.avatar_icon_fit ||
      (previous.global_custom_system_prompt ?? '') !==
        (currentPayload.global_custom_system_prompt ?? '')

    if (!hasChanges) {
      return
    }

    const profileChanged = makeProfileSignature(currentPayload) !== persistedProfileSignature
    const promptChanged = makePromptSignature(currentPayload) !== persistedPromptSignature
    activeSaveScope = promptChanged && !profileChanged ? 'prompt' : 'profile'

    const validationMessage = validateDisplayName(settings.displayName)
    if (validationMessage) {
      // Keep save state idle while user fixes validation issues.
      saveState = 'idle'
      return
    }

    saveState = 'saving'
    saveError = null
    queueDebouncedSave(currentPayload)
  })

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')

      if (!response.ok) {
        const message = await extractError(response, 'Failed to load settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      const next = normaliseSettings(remoteSettings ?? data?.userSettings)

      untrack(() => {
        settings = { ...next }
        persistedSettings = { ...next }
        persistedProfileSignature = makeProfileSignature(next)
        persistedPromptSignature = makePromptSignature(next)
        isLoading = false
        saveError = null
        activeSaveScope = null
      })

      if (remoteSettings) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Failed to load user settings:', error)
      const fallback = normaliseSettings(data?.userSettings)

      untrack(() => {
        settings = { ...fallback }
        persistedSettings = { ...fallback }
        persistedProfileSignature = makeProfileSignature(fallback)
        persistedPromptSignature = makePromptSignature(fallback)
        isLoading = false
        saveError = error instanceof Error ? error.message : 'Failed to load settings'
        activeSaveScope = null
      })
    }
  }

  async function handleAvatarUpload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]

    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file for the avatar.')
      return
    }

    if (file.size > MAX_AVATAR_BYTES) {
      toast.error('Avatar must be 2MB or smaller.')
      return
    }

    if (!userId) {
      toast.error('You must be signed in to update your avatar.')
      return
    }

    isUploadingAvatar = true

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('entityType', 'user')
      formData.append('entityId', userId)

      if (persistedSettings?.avatar_url) {
        formData.append('oldAvatarUrl', persistedSettings.avatar_url)
      }

      const uploadResponse = await fetch('/api/uploads/avatar', {
        method: 'POST',
        body: formData
      })

      if (!uploadResponse.ok) {
        const message = await extractError(uploadResponse, 'Failed to upload avatar')
        throw new Error(message)
      }

      const { url } = await uploadResponse.json()

      untrack(() => {
        settings.avatar_url = url
      })

      toast.success('Avatar updated. Auto-saving…')
    } catch (error) {
      console.error('Avatar upload failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to upload avatar')
    } finally {
      isUploadingAvatar = false
      // Reset file input so the same file can be selected again if needed.
      input.value = ''
    }
  }

  async function handleLogout() {
    logoutBusy = true
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (response.ok) {
        window.location.href = '/login'
      } else {
        const message = await extractError(response, 'Failed to logout')
        throw new Error(message)
      }
    } catch (error) {
      console.error('Logout failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to logout')
    } finally {
      logoutBusy = false
    }
  }

  function normaliseSettings(row?: UserSettingsRow | SavePayload | null): SavePayload {
    return {
      displayName: (row?.displayName ?? '').toString(),
      avatar_url: row?.avatar_url ?? null,
      avatar_icon_ref: normalizeIconRef(row?.avatar_icon_ref, DEFAULT_USER_ICON_REF),
      avatar_icon_fit: normalizeAvatarIconFit(row?.avatar_icon_fit),
      global_custom_system_prompt: row?.global_custom_system_prompt ?? ''
    }
  }

  function validateDisplayName(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed.length) {
      return 'Display name is required'
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or less`
    }
    return null
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json()
      return data?.error || data?.message || fallback
    } catch {
      return fallback
    }
  }

  const avatarPreview = $derived(settings.avatar_url ?? null)
  const avatarIconRef = $derived(settings.avatar_icon_ref ?? DEFAULT_USER_ICON_REF)
  const displayNameValue = $derived(settings.displayName)

  function clearUserAvatar() {
    settings.avatar_url = null
  }

  function chooseUserAvatarIcon(iconRef: IconRef) {
    settings.avatar_url = null
    settings.avatar_icon_ref = iconRef
    settings.avatar_icon_fit = 'fill'
  }

  function openGlobalPromptEditor() {
    globalPromptDraft = settings.global_custom_system_prompt ?? ''
    globalPromptEditorOpen = true
  }

  async function saveGlobalPrompt(newPrompt: string) {
    suppressNextAutoSave = true
    settings.global_custom_system_prompt = newPrompt
    globalPromptDraft = newPrompt
    globalPromptEditorOpen = false

    const payload: SavePayload = {
      displayName: settings.displayName.trim(),
      avatar_url: settings.avatar_url ?? null,
      avatar_icon_ref: settings.avatar_icon_ref,
      avatar_icon_fit: settings.avatar_icon_fit,
      global_custom_system_prompt: newPrompt
    }

    const validationMessage = validateDisplayName(settings.displayName)
    if (validationMessage) {
      saveState = 'idle'
      saveError = validationMessage
      return
    }

    saveState = 'saving'
    saveError = null
    activeSaveScope = 'prompt'
    await flushDebouncedSave(payload)
  }

  function makeProfileSignature(payload: SavePayload) {
    return JSON.stringify({
      displayName: payload.displayName.trim(),
      avatar_url: payload.avatar_url ?? null,
      avatar_icon_ref: iconRefKey(payload.avatar_icon_ref),
      avatar_icon_fit: payload.avatar_icon_fit
    })
  }

  function makePromptSignature(payload: SavePayload) {
    return JSON.stringify({
      global_custom_system_prompt: payload.global_custom_system_prompt ?? ''
    })
  }
</script>

{#if isLoading}
  <div class="flex items-center justify-center p-12">
    <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    <span class="ml-2 text-sm text-muted-foreground">Loading settings…</span>
  </div>
{:else}
  <div class="batshit-settings-surface">
    <div class="space-y-4">
      <Card.Root class="batshit-settings-card batshit-settings-card-default">
        <Card.Header>
          <div class="space-y-3">
            <div class="flex items-center gap-2">
              <Card.Title class="flex items-center gap-2">
                <UserRound class="h-4 w-4" />
                User Settings
              </Card.Title>
            </div>
          </div>
        </Card.Header>
      </Card.Root>

      <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card">
        <Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex items-center gap-1.5">
            <Card.Title>Profile</Card.Title>
            <SettingsInfoMenu ariaLabel="About Profile" contentClass="w-80">
              <p>
                Update the name and avatar Batshit uses for your account. These changes autosave
                after a short pause.
              </p>
            </SettingsInfoMenu>
          </div>
          <SettingsSaveStatus
            state={activeSaveScope === 'profile' ? (saveError ? 'error' : saveState) : 'idle'}
            error={activeSaveScope === 'profile' ? saveError : null}
            savedLabel="Profile Saved"
            sticky={false}
          />
        </Card.Header>
        <Card.Content class="space-y-4 pt-4">
          <div class="batshit-settings-card-subtle-frame is-spacious">
            <div class="flex items-center gap-4">
              <EntityAvatar
                avatarUrl={avatarPreview}
                iconRef={avatarIconRef}
                iconFit={settings.avatar_icon_fit}
                label={displayNameValue || email || 'User'}
                fallback={displayNameValue || email || 'User'}
                class="batshit-settings-avatar-preview"
                iconClass="text-muted-foreground"
              />

              <div class="space-y-2 text-sm text-muted-foreground">
                <div class="batshit-settings-form-label-line">
                  <p class="batshit-settings-form-label">Avatar</p>
                  <SettingsInfoMenu ariaLabel="About Avatar Upload">
                    <p>JPEG, PNG, or WebP. Maximum file size is 2MB.</p>
                  </SettingsInfoMenu>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <label class="batshit-settings-upload-action">
                    <UploadCloud class="h-4 w-4" />
                    <span>{isUploadingAvatar ? 'Uploading…' : 'Upload Avatar'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      class="sr-only"
                      onchange={handleAvatarUpload}
                      disabled={isUploadingAvatar}
                    />
                  </label>
                  <IconPicker
                    bind:value={settings.avatar_icon_ref}
                    triggerLabel="Use Icon"
                    onSelect={chooseUserAvatarIcon}
                    onlineSearchHint={settings.displayName}
                  />
                  {#if settings.avatar_url}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      class="is-danger"
                      onclick={clearUserAvatar}
                      disabled={isUploadingAvatar}
                      title="Remove Avatar"
                      aria-label="Remove Avatar"
                    >
                      <Trash2 />
                    </Button>
                  {/if}
                </div>
              </div>
            </div>
          </div>

          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label.Root for="display-name" class="batshit-settings-form-label">Display Name</Label.Root>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="display-name"
                  bind:value={settings.displayName}
                  maxlength={MAX_DISPLAY_NAME_LENGTH}
                  placeholder="Pick something memorable"
                />
                {#if displayNameError}
                  <p class="mt-1 inline-flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle class="h-3 w-3" />
                    {displayNameError}
                  </p>
                {/if}
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label.Root for="email" class="batshit-settings-form-label">Email</Label.Root>
                  <SettingsInfoMenu ariaLabel="About Email" contentClass="w-72">
                    <p>
                      Email is read-only here for now. If this ever needs to change, it has to go
                      through account support rather than inline settings.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id="email"
                  value={email}
                  readonly
                  class="bg-muted text-muted-foreground"
                />
              </div>
            </div>
          </div>
        </Card.Content>
      </Card.Root>

      <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card">
        <Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex items-center gap-1.5">
            <Card.Title class="flex items-center gap-2">
              <Sparkles class="h-4 w-4 text-primary" />
              Global System Prompt
            </Card.Title>
            <SettingsInfoMenu ariaLabel="About Global System Prompt" contentClass="w-80">
              <p>
                Optional instructions appended to every agent by default. Use it for tone,
                disclaimers, or house rules you want Batshit to apply everywhere.
              </p>
            </SettingsInfoMenu>
          </div>
          <SettingsSaveStatus
            state={activeSaveScope === 'prompt' ? (saveError ? 'error' : saveState) : 'idle'}
            error={activeSaveScope === 'prompt' ? saveError : null}
            savedLabel="Prompt Saved"
            sticky={false}
          />
        </Card.Header>
        <Card.Content class="space-y-4 pt-4">
          <Button variant="outline" class="batshit-button-full batshit-button-content-between" onclick={openGlobalPromptEditor}>
            <span class="flex items-center gap-2">
              <Pencil aria-hidden="true" />
              <span>{settings.global_custom_system_prompt ? 'Edit Global System Prompt' : 'Create Global System Prompt'}</span>
            </span>
            <span class="batshit-settings-form-label">Opens Editor</span>
          </Button>
        </Card.Content>
      </Card.Root>

      <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card">
        <Card.Header>
          <Card.Title>Session</Card.Title>
        </Card.Header>
        <Card.Content class="pt-4">
          <Button
            variant="destructive"
            onclick={handleLogout}
            disabled={logoutBusy}
            class="batshit-button-responsive-auto"
          >
            {#if logoutBusy}
              <Loader2 class="animate-spin" aria-hidden="true" />
            {:else}
              <LogOut  aria-hidden="true" />
            {/if}
            Log Out
          </Button>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
{/if}

<SystemPromptEditor
  bind:open={globalPromptEditorOpen}
  title="Global System Prompt"
  description="Optional instructions appended to every agent by default."
  prompt={globalPromptDraft}
  readOnly={false}
  width="large"
  onSave={saveGlobalPrompt}
/>
