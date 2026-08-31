<script lang="ts">
  import { Loader2, Mic, UploadCloud } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import VoiceProviderIcon from '$lib/components/settings/voice/VoiceProviderIcon.svelte'
  import type { VoiceProviderSummary } from '$lib/types/voice'

  interface Props {
    cloneProviderOptions: VoiceProviderSummary[]
    cloneProviderReady: VoiceProviderSummary | null
    cloneTranscribeProviderOptions: VoiceProviderSummary[]
    selectedCloneTranscribeProvider: VoiceProviderSummary | null
    cloneFile: File | null
    clonePreviewUrl: string | null
    cloneTranscribeBusy: boolean
    cloneTranscribeError: string | null
    cloneError: string | null
    cloneBusy: boolean
    cloneProvider?: string
    cloneName?: string
    cloneReferenceText?: string
    cloneTranscribeProvider?: string
    cloneConsent?: boolean
    onCloneFileChange: (event: Event) => void
    onTranscribeCloneReference: () => void
    onCloneVoice: () => void
  }

  let {
    cloneProviderOptions,
    cloneProviderReady,
    cloneTranscribeProviderOptions,
    selectedCloneTranscribeProvider,
    cloneFile,
    clonePreviewUrl,
    cloneTranscribeBusy,
    cloneTranscribeError,
    cloneError,
    cloneBusy,
    cloneProvider = $bindable(''),
    cloneName = $bindable(''),
    cloneReferenceText = $bindable(''),
    cloneTranscribeProvider = $bindable(''),
    cloneConsent = $bindable(false),
    onCloneFileChange,
    onTranscribeCloneReference,
    onCloneVoice
  }: Props = $props()
</script>

<div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
  <div class="flex items-center gap-1.5">
    <p class="batshit-settings-form-label">Create a Voice Clone</p>
    <SettingsInfoMenu ariaLabel="About Create a Voice Clone" contentClass="w-80">
      <p>
        Use a clean reference clip. For Qwen-style engines, including the spoken transcript can
        improve clone quality before you save the clone.
      </p>
    </SettingsInfoMenu>
  </div>

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
        </div>
      </div>
      <div class="batshit-settings-form-control-group">
        <Select.Root
          type="single"
          value={cloneProvider as unknown as string}
          onValueChange={(value) => (cloneProvider = Array.isArray(value) ? (value[0] ?? '') : (value ?? ''))}
        >
          <Select.Trigger class="w-full justify-between">
            <span class="flex min-w-0 items-center gap-2">
              <VoiceProviderIcon
                providerId={cloneProviderReady?.id}
                label={cloneProviderReady?.label}
              />
                    <span class="truncate">
                      {cloneProviderReady?.label ?? 'Choose a clone-capable provider'}
              </span>
            </span>
          </Select.Trigger>
          <Select.Content>
            {#each cloneProviderOptions as provider (provider.id)}
              <Select.Item value={provider.id}>
                <div class="flex items-center justify-between gap-2">
                  <span class="flex min-w-0 items-center gap-2">
                    <VoiceProviderIcon providerId={provider.id} label={provider.label} />
                    <span class="truncate">{provider.label}</span>
                  </span>
                  {#if provider.ready === false}
                    <Badge variant="outline" class="batshit-settings-pill is-warning">
                      {provider.statusHint ?? 'Not ready'}
                    </Badge>
                  {/if}
                </div>
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        {#if cloneProviderReady?.ready === false && cloneProviderReady.statusHint}
          <p class="batshit-settings-inline-alert is-warning">
            {cloneProviderReady.statusHint}
          </p>
        {/if}
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Label class="batshit-settings-form-label">Clone Name</Label.Label>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input placeholder="Warm narrator" bind:value={cloneName} />
      </div>
    </div>

    <div class="batshit-settings-form-row is-tall">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Label class="batshit-settings-form-label">Reference Audio</Label.Label>
          <SettingsInfoMenu ariaLabel="About Reference Audio" contentClass="w-80">
            <p>
              Batshit stores the uploaded sample under your managed runtime so clone-capable BYO
              engines can reuse it during synthesis.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control-group">
        <input
          type="file"
          accept="audio/*"
          class="batshit-settings-selector-trigger batshit-settings-file-input block w-full"
          onchange={onCloneFileChange}
        />
        {#if clonePreviewUrl}
          <div class="batshit-settings-card-subtle-frame is-compact space-y-2">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1.5">
                <p class="batshit-settings-form-label">Reference Audio Preview</p>
                <SettingsInfoMenu ariaLabel="About Reference Audio Preview">
                  <p>
                    Listen to the uploaded clip while you work on the reference transcript below.
                  </p>
                </SettingsInfoMenu>
              </div>
              {#if cloneFile}
                <p class="batshit-settings-caption truncate">{cloneFile.name}</p>
              {/if}
            </div>
            <audio class="w-full" controls preload="metadata" src={clonePreviewUrl}></audio>
          </div>
        {/if}
      </div>
    </div>

    <div class="batshit-settings-form-row is-tall">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Label class="batshit-settings-form-label">Reference Transcript</Label.Label>
          <SettingsInfoMenu ariaLabel="About Reference Transcript" contentClass="w-80">
            <p>
              Paste what the reference speaker says if you know it. Some clone paths, like Qwen3,
              can produce better results with that transcript.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control-group">
        {#if cloneTranscribeProviderOptions.length > 0}
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-0 flex-1">
              <Select.Root
                type="single"
                value={cloneTranscribeProvider as unknown as string}
                onValueChange={(value) =>
                  (cloneTranscribeProvider = Array.isArray(value) ? (value[0] ?? '') : (value ?? ''))}
              >
                <Select.Trigger class="w-full">
                  <span class="flex min-w-0 items-center gap-2">
                    <VoiceProviderIcon
                      providerId={selectedCloneTranscribeProvider?.id}
                      label={selectedCloneTranscribeProvider?.label}
                    />
                    <span class="truncate">
                      {selectedCloneTranscribeProvider?.label ?? 'Choose STT provider'}
                    </span>
                  </span>
                </Select.Trigger>
                <Select.Content>
                  {#each cloneTranscribeProviderOptions as provider (provider.id)}
                    <Select.Item value={provider.id}>
                      <div class="flex items-center justify-between gap-2">
                        <span class="flex min-w-0 items-center gap-2">
                          <VoiceProviderIcon providerId={provider.id} label={provider.label} />
                          <span class="truncate">{provider.label}</span>
                        </span>
                        {#if provider.ready === false}
                          <Badge variant="outline" class="batshit-settings-pill is-warning">
                            {provider.statusHint ?? 'Not ready'}
                          </Badge>
                        {/if}
                      </div>
                    </Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
            <Button
              size="sm"
              variant="outline"
              onclick={onTranscribeCloneReference}
              disabled={cloneTranscribeBusy || !cloneFile || cloneTranscribeProviderOptions.length === 0}
            >
              {#if cloneTranscribeBusy}
                <Loader2 class="animate-spin" />
              {:else}
                <Mic />
              {/if}
              Transcribe
            </Button>
          </div>
        {/if}
        {#if cloneTranscribeProviderOptions.length === 0}
          <p class="batshit-settings-form-help">
            Add a server-side speech-to-text provider if you want Batshit to transcribe the uploaded
            sample for you.
          </p>
        {:else if selectedCloneTranscribeProvider?.ready === false && selectedCloneTranscribeProvider.statusHint}
          <p class="batshit-settings-inline-alert is-warning">
            {selectedCloneTranscribeProvider.statusHint}
          </p>
        {/if}
        <textarea
          class="batshit-settings-textarea min-h-20"
          placeholder="Paste what the reference speaker says if you know it."
          bind:value={cloneReferenceText}
        ></textarea>
        {#if cloneTranscribeError}
          <p class="batshit-settings-inline-alert is-danger">
            {cloneTranscribeError}
          </p>
        {/if}
      </div>
    </div>

    <div class="batshit-settings-toggle-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <p class="batshit-settings-parent-label">I Have Permission to Use This Voice Sample</p>
          <SettingsInfoMenu ariaLabel="About Voice Sample Permission" contentClass="w-72">
            <p>Only create voice clones from audio you are allowed to use.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <Switch.Root checked={cloneConsent} onCheckedChange={(value) => (cloneConsent = value === true)} />
    </div>
  </div>

  {#if cloneError}
    <p class="batshit-settings-inline-alert is-danger">
      {cloneError}
    </p>
  {/if}

  <div class="flex justify-end">
    <Button onclick={onCloneVoice} disabled={cloneBusy}>
      {#if cloneBusy}
        <Loader2 class="animate-spin" />
      {:else}
        <UploadCloud />
      {/if}
      Create Voice Clone
    </Button>
  </div>
</div>
