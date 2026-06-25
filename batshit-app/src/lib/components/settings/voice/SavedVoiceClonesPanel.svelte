<script lang="ts">
  import { Loader2, Play, Trash2 } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { VoiceProfileRecord } from '$lib/types/voice'

  interface Props {
    profiles: VoiceProfileRecord[]
    profilesLoading: boolean
    profilesError: string | null
    selectedClone: VoiceProfileRecord | null
    selectedCloneId?: string | null
    testPhrase?: string
    previewBusy: boolean
    onDeleteProfile: (profileId: string) => void
    onPreview: (clone: VoiceProfileRecord) => void
  }

  let {
    profiles,
    profilesLoading,
    profilesError,
    selectedClone,
    selectedCloneId = $bindable(null),
    testPhrase = $bindable(''),
    previewBusy,
    onDeleteProfile,
    onPreview
  }: Props = $props()
</script>

<div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-1.5">
      <p class="batshit-settings-form-label">Saved Voice Clones</p>
      <SettingsInfoMenu ariaLabel="About Saved Voice Clones" contentClass="w-72">
        <p>
          Saved voice clones appear in the TTS voice dropdown for matching providers.
        </p>
      </SettingsInfoMenu>
    </div>
    {#if profilesLoading}
      <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
    {/if}
  </div>

  {#if profilesError}
    <p class="batshit-settings-inline-alert is-danger">
      {profilesError}
    </p>
  {:else if profiles.length === 0}
    <div class="batshit-settings-muted-panel batshit-settings-caption">
      No saved voice clones yet.
    </div>
  {:else}
    <div class="space-y-2">
      {#each profiles as profile (profile.id)}
        <div
          class={`batshit-settings-option-card w-full ${
            profile.id === selectedCloneId ? 'is-selected' : ''
          }`}
          data-state={profile.id === selectedCloneId ? 'active' : 'inactive'}
          aria-pressed={profile.id === selectedCloneId}
          role="button"
          tabindex="0"
          onclick={() => (selectedCloneId = profile.id)}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              selectedCloneId = profile.id
            }
          }}
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="batshit-settings-form-label truncate">{profile.name}</p>
                {#if profile.isClone}
                  <Badge variant="outline" class="batshit-settings-child-label">Clone</Badge>
                {/if}
                <Badge variant="outline" class="batshit-settings-child-label">{profile.provider}</Badge>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              class="is-danger"
              onclick={(event) => {
                event.stopPropagation()
                onDeleteProfile(profile.id)
              }}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if selectedClone}
    <div class="space-y-2 batshit-settings-muted-panel">
      <div class="flex items-center gap-1.5">
        <p class="batshit-settings-form-label">Preview Selected Clone</p>
        <SettingsInfoMenu ariaLabel="About Preview Selected Clone" contentClass="w-72">
          <p>
            Select one of the saved voice clones above, then test it here with your sample phrase.
          </p>
        </SettingsInfoMenu>
      </div>
      <p class="batshit-settings-form-label">
        Selected: {selectedClone.name}
      </p>
      <div class="flex items-center gap-2 no-lastpass">
        <Input
          id="voice-test"
          name="saved-clone-preview-phrase"
          type="text"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          bind:value={testPhrase}
        />
        <Button
          size="sm"
          variant="outline"
          onclick={() => onPreview(selectedClone)}
          disabled={previewBusy}
        >
          {#if previewBusy}
            <Loader2 class="animate-spin" />
          {:else}
            <Play />
          {/if}
          Play
        </Button>
      </div>
    </div>
  {/if}
</div>
