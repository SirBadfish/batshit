<script lang="ts">
  import { onMount } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import {
    PINOKIO_ARTIFACT_KIND_LABELS,
    PINOKIO_ARTIFACT_KINDS,
    isPinokioKind,
    type PinokioArtifactKind
  } from '$lib/artifacts/pinokioArtifact'

  /**
   * SA-072 P2 (DL-09): the two rows the "Pinokio App" power source adds under Artifact Power
   * Source: which kind of app it is (the real `source_type`) and which installed app
   * (`pinokio_app_id`). The address is never stored; Batshit asks Pinokio on every run. The
   * recipe that calls the app (`pinokio_runtime`) is the Artifact Creator's job, not a form.
   */
  interface Props {
    metadata: Record<string, any>
    onChange: (metadata: Record<string, any>) => void
  }

  type PinokioAppOption = { appId: string; title: string; state: string }

  let { metadata, onChange }: Props = $props()

  let apps = $state<PinokioAppOption[]>([])
  let loading = $state(false)
  let note = $state<string | null>(null)

  const kind = $derived<PinokioArtifactKind>(isPinokioKind(metadata?.source_type) ? metadata.source_type : 'comfyui')
  const appId = $derived(typeof metadata?.pinokio_app_id === 'string' ? metadata.pinokio_app_id : '')
  const selectedApp = $derived(apps.find((app) => app.appId === appId) ?? null)

  async function loadApps() {
    loading = true
    note = null
    try {
      const response = await fetch('/api/pinokio/apps')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) throw new Error(payload?.error || 'Batshit could not list the Pinokio apps.')
      apps = Array.isArray(payload.apps) ? payload.apps : []
      note = payload.message ?? (apps.length === 0 ? 'Pinokio has no apps installed yet.' : null)
    } catch (error) {
      note = error instanceof Error ? error.message : 'Batshit could not list the Pinokio apps.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void loadApps()
  })
</script>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">App Kind</Label.Root>
      <SettingsInfoMenu ariaLabel="About the Pinokio app kind" contentClass="w-80">
        <p>
          What the app is. Batshit calls it the way that kind of app expects, and the badge reads
          "ComfyUI via Pinokio", "Gradio via Pinokio", or "Custom API via Pinokio".
        </p>
      </SettingsInfoMenu>
    </div>
  </div>
  <div class="batshit-settings-form-control">
    <Select.Root
      type="single"
      value={kind}
      onValueChange={(value) => onChange({ ...metadata, source_type: value })}
    >
      <Select.Trigger>{PINOKIO_ARTIFACT_KIND_LABELS[kind]}</Select.Trigger>
      <Select.Content>
        {#each PINOKIO_ARTIFACT_KINDS as option (option)}
          <Select.Item value={option} label={PINOKIO_ARTIFACT_KIND_LABELS[option]}>
            {PINOKIO_ARTIFACT_KIND_LABELS[option]}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</div>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">Pinokio App</Label.Root>
      <SettingsInfoMenu ariaLabel="About the Pinokio app" contentClass="w-80">
        <p>
          An app installed in Pinokio on this computer. Batshit asks Pinokio where the app answers
          every time the artifact runs. When the app is not running, the artifact offers
          "Start with Pinokio", and Batshit starts it only after you confirm. Batshit never
          installs, stops, or deletes Pinokio apps.
        </p>
      </SettingsInfoMenu>
    </div>
  </div>
  <div class="batshit-settings-form-control">
    <div class="batshit-settings-field-cluster">
      <Select.Root
        type="single"
        value={appId}
        onValueChange={(value) => onChange({ ...metadata, pinokio_app_id: value })}
      >
        <Select.Trigger>
          {#if selectedApp}
            {selectedApp.title}
          {:else if appId}
            {appId}
          {:else}
            Choose an installed app
          {/if}
        </Select.Trigger>
        <Select.Content>
          {#if appId && !selectedApp}
            <Select.Item value={appId} label={appId}>{appId} (not found in Pinokio)</Select.Item>
          {/if}
          {#each apps as app (app.appId)}
            <Select.Item value={app.appId} label={app.title}>
              <div class="flex min-w-0 flex-col">
                <span class="truncate">{app.title}</span>
                <span class="batshit-settings-caption truncate">{app.appId}</span>
              </div>
            </Select.Item>
          {/each}
          {#if apps.length === 0 && !appId}
            <Select.Label>{loading ? 'Loading apps…' : 'No Pinokio apps found'}</Select.Label>
          {/if}
        </Select.Content>
      </Select.Root>
      <Button variant="ghost" size="icon" onclick={loadApps} disabled={loading} title="Refresh the Pinokio apps">
        <RefreshCw class={loading ? 'animate-spin' : ''} />
      </Button>
    </div>
    {#if note}
      <p class="batshit-settings-form-meta is-warning">{note}</p>
    {/if}
  </div>
</div>
