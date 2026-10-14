<script lang="ts">
  import { performAvatarImport, uploadAvatarFile } from '$lib/appActions/imports/avatars'
  import type { ImportArgs, ImportOutcome } from '$lib/appActions/imports/contracts'
  import type { ActionContext } from '$lib/appActions/owners'
  import { refuse } from '$lib/appActions/catalog'

  import { onMount, onDestroy, untrack } from 'svelte'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import { Button } from '$lib/components/ui/button'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import * as Card from '$lib/components/ui/card'
  import * as Select from '$lib/components/ui/select'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import { Loader2, LogOut, AlertCircle, UploadCloud, Sparkles, UserRound, Pencil, Trash2, MessageSquareMore, RefreshCw } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmUserSettings as setUserSettings } from '$lib/stores/userSettings.svelte'
  import { requestAvatarPictureTidy, shouldTidyAvatarPictures } from '$lib/utils/avatarPictureTidy'
  import type { UserSettingsRow } from '$lib/types/database'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
  import { iconRefKey, normalizeAvatarIconFit } from '$lib/icons/iconTypes'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import {
    busySendModeLabel,
    resolveBusySendMode,
    type BusySendMode
  } from '$lib/utils/steerControl'

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
    /** SA-114 P3 (DL-114-01): what a send does while the agent is still replying. */
    global_chat_settings: { busy_send_mode: BusySendMode }
  }

  let { data = null }: { data?: PanelData } = $props()

  let settings = $state<SavePayload>(normaliseSettings(null))
  let persistedSettings = $state<SavePayload | null>(null)
  let email = $state('')
  let userId = $state<string | null>(null)

  let isLoading = $state(true)
  // BL-962: `settings` holds saved values only after a real read of `/api/user/settings`
  // succeeded. Until then it holds the page's older copy or the defaults, neither of which may
  // ever be written back (a save sends the name, avatar, Global System Prompt and busy-send
  // mode together, and the route stores each one it is sent), so the three cards that hold them
  // are not offered and both writers (the autosave and the prompt editor's save) return. The
  // page's copy is from when the page opened: it does not count as loaded, and it cannot tell
  // "no record yet" from "the read failed".
  let settingsLoaded = $state(false)
  let loadError = $state<string | null>(null)
  let settingsLoadBusy = $state(false)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedProfileSignature = $state(makeProfileSignature(normaliseSettings(null)))
  let persistedPromptSignature = $state(makePromptSignature(normaliseSettings(null)))
  let persistedChatSignature = $state(makeChatSignature(normaliseSettings(null)))
  let activeSaveScope = $state<'profile' | 'prompt' | 'chat' | null>(null)
  let isUploadingAvatar = $state(false)
  let avatarAppActionBusy = $state(false)
  let avatarPanelAlive = true
  onDestroy(() => { avatarPanelAlive = false })
  let logoutBusy = $state(false)
  let globalPromptEditorOpen = $state(false)
  let globalPromptDraft = $state('')
  let pendingSaveTimeout: ReturnType<typeof setTimeout> | null = null
  let pendingSavePayload: SavePayload | null = null
  // BL-481 follow-up: the signature of the payload most recently handed to `persistSettings`,
  // set the moment a send starts and cleared once it fails (persistSettings' catch clears it —
  // a failed send must not block a later DELIBERATE retry of the same value, only the automatic
  // re-send this guards against while the attempt is still in flight or just settled). The
  // shared autosave effect skips queuing a save that would send this exact payload again, so an
  // explicit save in flight (`saveGlobalPrompt`) is never duplicated by the effect noticing the
  // same mutation before `persistedSettings` catches up (Settings Auto-Save Contract: retry
  // only on a deliberate next edit or panel-specific save action).
  let lastDispatchedSignature: string | null = null
  // BL-481 review: true only while a `persistSettings` fetch is actually running. Lets the
  // effect tell "a queued-but-not-yet-sent save was just cancelled, so saveState should settle
  // back to idle" apart from "a real save is in flight or just succeeded, so saveState is
  // someone else's to manage" — conflating the two left the chip stuck on "Saving..." forever
  // after a cancelled queue, and would otherwise let a reset cut the normal 2s "Saved" flash
  // short the instant persistedSettings updates.
  let saveInFlight = false

  const displayNameError = $derived(validateDisplayName(settings.displayName))

  $effect(() => {
    if (isLoading) {
      const next = normaliseSettings(data?.userSettings)
      settings = { ...next }
      persistedSettings = data?.userSettings ? { ...next } : null
      persistedProfileSignature = makeProfileSignature(next)
      persistedPromptSignature = makePromptSignature(next)
      persistedChatSignature = makeChatSignature(next)
    }
    email = data?.user?.email ?? ''
    userId = data?.user?.id ?? null
  })

  onMount(async () => {
    await loadSettings()
  })

  async function persistSettings(payload: SavePayload) {
    // BL-481 follow-up: record what is being sent BEFORE the request goes out — cleared on
    // failure in the catch block below, left set through success. See `lastDispatchedSignature`.
    lastDispatchedSignature = makeFullSignature(payload)
    saveInFlight = true
    // BL-281: the picture the saved settings showed before this save, for the tidy below.
    const previousAvatar = persistedSettings?.avatar_url ?? null
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
        persistedChatSignature = makeChatSignature(nextPersisted)
        saveState = 'saved'
        saveError = null
      })

      if (updated || result?.settings === null) {
        setUserSettings(updated)
      }

      // BL-281: the save changed the picture, so the pictures the settings no longer show go.
      const tidyAvatarPictures = untrack(() =>
        shouldTidyAvatarPictures({
          previous: previousAvatar,
          saved: updated ? (updated.avatar_url ?? null) : payload.avatar_url,
          current: settings.avatar_url ?? null,
          uploading: isUploadingAvatar
        })
      )
      if (tidyAvatarPictures && userId) void requestAvatarPictureTidy('user', userId, previousAvatar)
    } catch (error) {
      console.error('Failed to save user settings:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save settings'
      })
      // BL-481 follow-up (review item 3): a failed send must not block a later DELIBERATE
      // retry of the exact same value — the effect's `lastDispatchedSignature` guard exists to
      // stop an automatic re-send of a payload already in flight or just settled, not to lock
      // out a real retry once the attempt has actually failed and settled.
      lastDispatchedSignature = null
    } finally {
      saveInFlight = false
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 2000)
    }
  }

  // BL-481 follow-up (review): drop a queued-but-not-yet-sent save with no side effect. Safe to
  // call whenever the effect decides no new save is needed right now — it can never touch an
  // ALREADY in-flight `fetch` (that lives inside a running `persistSettings` call, not in this
  // timer), only a future one that has not started yet.
  function cancelQueuedSave() {
    if (pendingSaveTimeout) {
      clearTimeout(pendingSaveTimeout)
      pendingSaveTimeout = null
    }
    pendingSavePayload = null
  }

  // BL-481 review: settle a "saving" chip left behind by a queued save that was just cancelled.
  // Never touches 'saved' (the real 2s flash after a real success) or an already-'idle' state,
  // and never fires while a real `persistSettings` fetch is genuinely in flight — that call owns
  // its own saveState transition.
  function settleToIdleIfNoSaveInFlight() {
    if (!saveInFlight && saveState === 'saving') {
      saveState = 'idle'
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
    // BL-962: never a payload built while no read of the saved settings succeeded. The cards are
    // not offered then either; this line keeps the record from being sent if one ever is. Both
    // flags are `$state`, so the effect wakes when either flips (unlike the plain flag of BL-481).
    if (isLoading || !settingsLoaded) return

    const currentPayload: SavePayload = {
      displayName: settings.displayName.trim(),
      avatar_url: settings.avatar_url ?? null,
      avatar_icon_ref: settings.avatar_icon_ref,
      avatar_icon_fit: settings.avatar_icon_fit,
      global_custom_system_prompt: settings.global_custom_system_prompt ?? '',
      global_chat_settings: { ...settings.global_chat_settings }
    }

    const previous = persistedSettings
    const matchesPersisted =
      Boolean(previous) &&
      previous!.displayName === currentPayload.displayName &&
      (previous!.avatar_url ?? null) === (currentPayload.avatar_url ?? null) &&
      iconRefKey(previous!.avatar_icon_ref) === iconRefKey(currentPayload.avatar_icon_ref) &&
      previous!.avatar_icon_fit === currentPayload.avatar_icon_fit &&
      (previous!.global_custom_system_prompt ?? '') ===
        (currentPayload.global_custom_system_prompt ?? '') &&
      previous!.global_chat_settings.busy_send_mode ===
        currentPayload.global_chat_settings.busy_send_mode

    // BL-481 follow-up: an explicit save (`saveGlobalPrompt`) already has this exact payload
    // in flight, or just settled with it — do not queue a second send of it. This also means a
    // failed explicit save is never auto-retried here; only a genuinely different later edit
    // (whose payload signature differs) reaches the code below (`persistSettings` clears this
    // on failure, so a deliberate retry of the SAME value is never blocked either).
    const matchesLastDispatched = makeFullSignature(currentPayload) === lastDispatchedSignature

    if (matchesLastDispatched || matchesPersisted) {
      // Review: either exit used to leave a stale queued save — for a DIFFERENT edit the user
      // has since abandoned — ticking. Left alone, it fires ~500ms later and silently
      // overwrites the server with a value the field no longer shows, while the chip still
      // says saved.
      cancelQueuedSave()
      // A save actually still in flight, or one that just succeeded, owns its own saveState
      // transition (persistSettings' success/finally, including the normal 2s "Saved" flash);
      // `settleToIdleIfNoSaveInFlight` only settles a "Saving..." chip that the cancelled queue
      // above was the sole reason for, and never touches 'saved' or a real in-flight 'saving'.
      settleToIdleIfNoSaveInFlight()
      // Clear a STALE ERROR: one with no natural expiry, left over from an earlier failed
      // attempt, once the field is back to something genuinely already saved. Read through
      // `untrack`: a plain read would make `saveError` a tracked dependency, so persistSettings'
      // catch block SETTING it (with `lastDispatchedSignature` already cleared, per the fix
      // below) would immediately re-run this effect and queue an automatic retry of the same
      // failed payload — exactly the un-requested retry this whole mechanism exists to prevent.
      if (!saveInFlight && matchesPersisted && untrack(() => saveError)) {
        saveError = null
      }
      return
    }

    const profileChanged = makeProfileSignature(currentPayload) !== persistedProfileSignature
    const promptChanged = makePromptSignature(currentPayload) !== persistedPromptSignature
    const chatChanged = makeChatSignature(currentPayload) !== persistedChatSignature
    activeSaveScope = chatChanged && !profileChanged && !promptChanged
      ? 'chat'
      : promptChanged && !profileChanged
        ? 'prompt'
        : 'profile'

    const validationMessage = validateDisplayName(settings.displayName)
    if (validationMessage) {
      // BL-481 review: this exit used to leave a queued save from BEFORE the field became
      // invalid still ticking — e.g. type "Jo" (valid, queues), clear the field within 500ms
      // (invalid) — "Jo" still posted while the field showed empty, and the chip said Saved.
      cancelQueuedSave()
      // Keep save state idle while user fixes validation issues, but never while a real save
      // for some OTHER already-valid value is genuinely still in flight.
      settleToIdleIfNoSaveInFlight()
      return
    }

    saveState = 'saving'
    saveError = null
    queueDebouncedSave(currentPayload)
  })

  async function loadSettings() {
    settingsLoadBusy = true
    try {
      const response = await fetch('/api/user/settings')

      if (!response.ok) {
        const message = await extractError(response, 'Failed to load settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      // The read is the only source: a read that succeeded and found no record opens with the
      // defaults, never with the page's older copy.
      const next = normaliseSettings(remoteSettings)

      untrack(() => {
        settings = { ...next }
        persistedSettings = { ...next }
        persistedProfileSignature = makeProfileSignature(next)
        persistedPromptSignature = makePromptSignature(next)
        persistedChatSignature = makeChatSignature(next)
        settingsLoaded = true
        isLoading = false
        saveError = null
        activeSaveScope = null
      })

      if (remoteSettings || result?.settings === null) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Failed to load user settings:', error)
      // Nothing is applied: the panel keeps no copy that could look saved, and the failure shows
      // in the notice that stands in for the cards (with a Retry).
      untrack(() => {
        loadError = error instanceof Error ? error.message : 'Failed to load settings'
        isLoading = false
      })
    } finally {
      untrack(() => {
        settingsLoadBusy = false
      })
    }
  }

  export function suppliedAvatarAvailability(args: ImportArgs['avatar.import_file']): string {
    if (!avatarPanelAlive || args.entityType !== 'user' || args.entityId !== userId) return 'unsupported_target'
    if (!settingsLoaded || isLoading || settingsLoadBusy) return 'settings_unconfirmed'
    if (avatarAppActionBusy || isUploadingAvatar || saveInFlight || pendingSavePayload || pendingSaveTimeout) return 'owner_busy'
    if (makeProfileSignature(settings) !== persistedProfileSignature || makePromptSignature(settings) !== persistedPromptSignature || makeChatSignature(settings) !== persistedChatSignature) return 'unsaved_changes'
    return 'available'
  }

  export async function importAppActionAvatar(
    args: ImportArgs['avatar.import_file'], files: File[], context: ActionContext
  ): Promise<ImportOutcome> {
    const available = suppliedAvatarAvailability(args)
    if (available !== 'available') refuse(available)
    const initialSignature = makeFullSignature(settings)
    const check = () => { if (!avatarPanelAlive || userId !== args.entityId || !settingsLoaded || isLoading) refuse('target_changed') }
    avatarAppActionBusy = true
    isUploadingAvatar = true
    try {
      return await performAvatarImport(files[0], args, {
        check,
        stage: url => {
          if (makeFullSignature(settings) !== initialSignature || saveInFlight) refuse('unsaved_changes')
          untrack(() => { settings.avatar_url = url; saveError = null; isUploadingAvatar = false })
        },
        savedAvatar: () => persistedSettings?.avatar_url ?? null,
        saveError: () => saveError
      }, context)
    } finally {
      avatarAppActionBusy = false
      isUploadingAvatar = false
    }
  }

  async function handleAvatarUpload(event: Event) {
    if (avatarAppActionBusy) return
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
      const url = await uploadAvatarFile(file, { entityType: 'user', entityId: userId })

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
      global_custom_system_prompt: row?.global_custom_system_prompt ?? '',
      // `resolveBusySendMode` is THE rule (DL-114-01); this panel reads it rather than
      // restating the default, so the control can never show a different answer from the
      // one the send button acts on.
      global_chat_settings: { busy_send_mode: resolveBusySendMode(row) }
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
    // BL-962: the editor only opens from a card that is shown after a real read; this keeps the
    // whole record from being built and sent from a copy that was never read.
    if (!settingsLoaded) return
    settings.global_custom_system_prompt = newPrompt
    globalPromptDraft = newPrompt
    globalPromptEditorOpen = false

    const payload: SavePayload = {
      displayName: settings.displayName.trim(),
      avatar_url: settings.avatar_url ?? null,
      avatar_icon_ref: settings.avatar_icon_ref,
      avatar_icon_fit: settings.avatar_icon_fit,
      global_custom_system_prompt: newPrompt,
      // Carried, not defaulted: the prompt editor saves the whole record, and sending the
      // default here would silently reset a busy-send mode the user had chosen.
      global_chat_settings: { ...settings.global_chat_settings }
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

  function makeChatSignature(payload: SavePayload) {
    return JSON.stringify({
      busy_send_mode: payload.global_chat_settings.busy_send_mode
    })
  }

  // BL-481 follow-up: one signature covering the whole payload, for comparing against the
  // last-dispatched send (see `lastDispatchedSignature`). Separate from the three scoped
  // signatures above, which exist to classify which card's save chip to light up.
  function makeFullSignature(payload: SavePayload) {
    return JSON.stringify({
      displayName: payload.displayName.trim(),
      avatar_url: payload.avatar_url ?? null,
      avatar_icon_ref: iconRefKey(payload.avatar_icon_ref),
      avatar_icon_fit: payload.avatar_icon_fit,
      global_custom_system_prompt: payload.global_custom_system_prompt ?? '',
      busy_send_mode: payload.global_chat_settings.busy_send_mode
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

      {#if !settingsLoaded}
        <!-- BL-962: the cards that hold saved values wait for a real read of the saved settings. -->
        <div class="batshit-settings-inline-alert is-danger" data-testid="user-settings-load-error">
          <div class="flex items-center justify-between gap-2">
            <span>
              User settings could not load, so the Profile, Global System Prompt, and Chat cards
              are hidden. Press Retry to load them.
              {#if loadError}Details: {loadError}{/if}
            </span>
            <Button variant="outline" size="sm" onclick={loadSettings} disabled={settingsLoadBusy}>
              <RefreshCw class={settingsLoadBusy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              Retry
            </Button>
          </div>
        </div>
      {:else}
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
                <Sparkles class="h-4 w-4 text-primary-text" />
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
          <Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="flex items-center gap-1.5">
              <Card.Title class="flex items-center gap-2">
                <MessageSquareMore class="h-4 w-4 text-primary-text" />
                Chat
              </Card.Title>
              <SettingsInfoMenu ariaLabel="About Chat" contentClass="w-80">
                <p>
                  Steer means your message waits for the agent to finish the tool it is running,
                  then lands inside the same reply, so the agent reads it and adjusts without
                  losing its place. Queue means it is held and sent the moment the reply ends, as
                  the next thing you say. Several queued messages go together, in the order you
                  sent them.
                </p>
                <p>
                  While the agent is busy the chat box shows both as buttons beside Stop. Enter
                  does whichever one you pick here, and Cmd/Ctrl+Enter does the other one for a
                  single message. Stop always stops the reply; to stop and send, press Stop, then
                  Enter.
                </p>
                <p>
                  A message with a file attached always queues, because a file cannot be handed
                  to an agent in the middle of a reply. Steer sends the words straight away and
                  leaves the file in the box for your next message, so nothing is thrown away.
                </p>
              </SettingsInfoMenu>
            </div>
            <SettingsSaveStatus
              state={activeSaveScope === 'chat' ? (saveError ? 'error' : saveState) : 'idle'}
              error={activeSaveScope === 'chat' ? saveError : null}
              savedLabel="Chat Saved"
              sticky={false}
            />
          </Card.Header>
          <Card.Content class="space-y-4 pt-4">
            <div class="batshit-settings-form-stack">
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label">
                      When You Send While the Agent Is Busy
                    </Label.Root>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    bind:value={settings.global_chat_settings.busy_send_mode}
                  >
                    <Select.Trigger data-testid="busy-send-mode-trigger">
                      {busySendModeLabel(settings.global_chat_settings.busy_send_mode)}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="steer" label="Steer (default)">
                        Steer (default)
                      </Select.Item>
                      <!--
                        F-P1-5: this offered "Interrupt and send" until SA-119 P2. The route
                        normalised the choice to Steer on save (DL-119-01), so the panel looked
                        like it had kept a choice it had not.
                      -->
                      <Select.Item value="queue" label="Queue">
                        Queue
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

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
