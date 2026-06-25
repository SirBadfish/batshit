<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import * as Select from '$lib/components/ui/select'
  import { Badge } from '$lib/components/ui/badge'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import { Button } from '$lib/components/ui/button'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import { Image, Loader2, Paperclip, RefreshCw } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import { BATSHIT_SERVER_URL } from '$lib/services/apiClient'
  import type { UserSettingsRow } from '$lib/types/database'

  type PanelData = {
    user?: {
      id: string
      email?: string | null
    } | null
    userSettings?: UserSettingsRow | null
  } | null

  type ClipSettingsState = {
    compressImages: boolean
    compressionQuality: number
    maxImageSize: string
    forceJpeg: boolean
    tunnelUrl: string
    useHttps: boolean
    tunnelProvider: 'none' | 'manual' | 'cloudflared_managed'
    cloudflaredAutoStart: boolean
    cloudflaredTargetUrl: string
  }

  type CloudflaredTunnelStatus = {
    installed: boolean
    supported?: boolean
    dockerUnsupported?: boolean
    supportLevel?: 'native-managed' | 'docker-deferred' | 'docker-sidecar'
    command: string | null
    version: string | null
    reason: string | null
    error?: string
    tunnel?: {
      running: boolean
      publicUrl: string | null
      targetUrl: string | null
      pid: number | null
      startedAt: string | null
      lastError: string | null
    }
    dockerSidecar?: {
      status: string
      publicUrl: string | null
      targetUrl: string | null
      lastSeenAt: string | null
      stale: boolean
    } | null
    autoStart?: boolean
    targetUrl?: string
    tunnelProvider?: string
  }

  const IMAGE_SIZE_OPTIONS = [
    { value: 'none', label: 'No resizing' },
    { value: '512', label: '512×512 pixels' },
    { value: '768', label: '768×768 pixels' },
    { value: '1024', label: '1024×1024 pixels' },
    { value: '1280', label: '1280×1280 pixels' },
    { value: '1536', label: '1536×1536 pixels' },
    { value: '2048', label: '2048×2048 pixels' }
  ]

  const SAVE_DEBOUNCE_MS = 500
  const DEFAULT_CLOUDFLARED_TARGET_URL = BATSHIT_SERVER_URL

  let { data = null }: { data?: PanelData } = $props()

  let clipSettings = $state<ClipSettingsState>(normaliseClipSettings(null))
  let persistedSignature = $state(makeSignature(normaliseClipSettings(null)))
  let persistedImageSignature = $state(makeImageSignature(normaliseClipSettings(null)))
  let persistedTunnelSignature = $state(makeTunnelSignature(normaliseClipSettings(null)))
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let activeSaveScope = $state<'image' | 'local' | null>(null)
  let isLoading = $state(true)
  let cloudflaredStatus = $state<CloudflaredTunnelStatus | null>(null)
  let cloudflaredBusy = $state(false)
  let cloudflaredError = $state<string | null>(null)

  $effect(() => {
    if (!isLoading) return
    const next = normaliseClipSettings(data?.userSettings)
    clipSettings = { ...next }
    persistedSignature = makeSignature(next)
    persistedImageSignature = makeImageSignature(next)
    persistedTunnelSignature = makeTunnelSignature(next)
  })

  onMount(async () => {
    await loadSettings()
    await loadCloudflaredStatus()
  })

  const debouncedSave = debounce(async (payload: any) => {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save clip settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updatedSettings: UserSettingsRow | null = result?.settings ?? null

      untrack(() => {
        persistedSignature = makeSignature(clipSettings)
        persistedImageSignature = makeImageSignature(clipSettings)
        persistedTunnelSignature = makeTunnelSignature(clipSettings)
        saveState = 'saved'
        saveError = null
      })

      if (updatedSettings) {
        setUserSettings(updatedSettings)
      }
    } catch (error) {
      console.error('Clip settings save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save clip settings'
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
  }, SAVE_DEBOUNCE_MS)

  // Auto-detect HTTPS from tunnel URL for manual tunnel mode
  $effect(() => {
    if (
      clipSettings.tunnelProvider === 'manual' &&
      clipSettings.tunnelUrl &&
      clipSettings.tunnelUrl.includes('https://')
    ) {
      clipSettings.useHttps = true
    }
  })

  // Managed Cloudflare tunnel always uses HTTPS
  $effect(() => {
    if (clipSettings.tunnelProvider === 'cloudflared_managed') {
      clipSettings.useHttps = true
    }
  })

  $effect(() => {
    if (isLoading) return

    const signature = makeSignature(clipSettings)
    if (signature === persistedSignature) {
      return
    }

    const imageChanged = makeImageSignature(clipSettings) !== persistedImageSignature
    const tunnelChanged = makeTunnelSignature(clipSettings) !== persistedTunnelSignature

    if (imageChanged && !tunnelChanged) {
      activeSaveScope = 'image'
    } else if (tunnelChanged && !imageChanged) {
      activeSaveScope = 'local'
    } else {
      activeSaveScope = tunnelChanged ? 'local' : 'image'
    }

    saveState = 'saving'
    saveError = null

    const uploadConfig = buildUploadSettings(clipSettings)

    debouncedSave({
      ui_settings: {
        compress_images: clipSettings.compressImages,
        compression_quality: clipSettings.compressionQuality,
        max_image_size: clipSettings.maxImageSize,
        force_jpeg: clipSettings.forceJpeg,
        upload_settings: uploadConfig
      },
      upload_settings: uploadConfig,
      upload_provider: 'local',
      updated_at: new Date().toISOString()
    })
  })

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load clip settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      const initial = normaliseClipSettings(remoteSettings ?? data?.userSettings)

      untrack(() => {
        clipSettings = { ...initial }
        persistedSignature = makeSignature(initial)
        persistedImageSignature = makeImageSignature(initial)
        persistedTunnelSignature = makeTunnelSignature(initial)
        isLoading = false
        saveError = null
        activeSaveScope = null
      })

      if (remoteSettings) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Clip settings load failed:', error)
      const fallback = normaliseClipSettings(data?.userSettings)

      untrack(() => {
        clipSettings = { ...fallback }
        persistedSignature = makeSignature(fallback)
        persistedImageSignature = makeImageSignature(fallback)
        persistedTunnelSignature = makeTunnelSignature(fallback)
        isLoading = false
        saveError = error instanceof Error ? error.message : 'Failed to load clip settings'
        activeSaveScope = null
      })
    }
  }

  function normaliseClipSettings(settings?: UserSettingsRow | null): ClipSettingsState {
    const uiSettings = (settings?.ui_settings as Record<string, any>) ?? {}
    const legacyUpload = settings ? ((settings as unknown as Record<string, any>).upload_settings as Record<string, any>) ?? {} : {}
    const nestedUpload = (uiSettings.upload_settings as Record<string, any>) ?? legacyUpload

    const maxSize = (() => {
      const value = uiSettings.max_image_size
      if (!value) return '1024'
      const found = IMAGE_SIZE_OPTIONS.find((option) => option.value === value)
      return found ? found.value : '1024'
    })()

    const tunnelUrl = typeof nestedUpload.tunnel_url === 'string' ? nestedUpload.tunnel_url : ''
    const tunnelProvider =
      nestedUpload.tunnel_provider === 'cloudflared_managed'
        ? 'cloudflared_managed'
        : nestedUpload.tunnel_provider === 'manual'
          ? 'manual'
          : nestedUpload.tunnel_provider === 'none'
            ? 'none'
            : tunnelUrl.trim().length > 0
              ? 'manual'
              : 'none'

    return {
      compressImages: uiSettings.compress_images !== false,
      compressionQuality: clampNumber(uiSettings.compression_quality ?? 40, 10, 100),
      maxImageSize: maxSize,
      forceJpeg: uiSettings.force_jpeg !== false,
      tunnelUrl,
      useHttps: nestedUpload.use_https === true,
      tunnelProvider,
      cloudflaredAutoStart: nestedUpload.cloudflared_auto_start === true,
      cloudflaredTargetUrl:
        typeof nestedUpload.cloudflared_target_url === 'string' &&
        nestedUpload.cloudflared_target_url.trim().length > 0
          ? nestedUpload.cloudflared_target_url.trim()
          : DEFAULT_CLOUDFLARED_TARGET_URL
    }
  }

  function clampNumber(value: unknown, min: number, max: number) {
    const num = typeof value === 'number' ? value : parseInt(value as string, 10)
    if (Number.isNaN(num)) return min
    return Math.min(Math.max(num, min), max)
  }

  function makeSignature(state: ClipSettingsState) {
    return JSON.stringify({
      compressImages: state.compressImages,
      compressionQuality: state.compressionQuality,
      maxImageSize: state.maxImageSize,
      forceJpeg: state.forceJpeg,
      tunnelUrl: state.tunnelUrl,
      useHttps: state.useHttps,
      tunnelProvider: state.tunnelProvider,
      cloudflaredAutoStart: state.cloudflaredAutoStart,
      cloudflaredTargetUrl: state.cloudflaredTargetUrl
    })
  }

  function makeImageSignature(state: ClipSettingsState) {
    return JSON.stringify({
      compressImages: state.compressImages,
      compressionQuality: state.compressionQuality,
      maxImageSize: state.maxImageSize,
      forceJpeg: state.forceJpeg
    })
  }

  function makeTunnelSignature(state: ClipSettingsState) {
    return JSON.stringify({
      tunnelUrl: state.tunnelUrl,
      useHttps: state.useHttps,
      tunnelProvider: state.tunnelProvider,
      cloudflaredAutoStart: state.cloudflaredAutoStart,
      cloudflaredTargetUrl: state.cloudflaredTargetUrl
    })
  }

  function buildUploadSettings(state: ClipSettingsState) {
    const isManagedCloudflare = state.tunnelProvider === 'cloudflared_managed'
    const isManualTunnel = state.tunnelProvider === 'manual'

    return {
      strategy: 'local',
      storage_mode: 'local',
      tunnel_url: isManualTunnel || isManagedCloudflare ? state.tunnelUrl : '',
      use_https: isManagedCloudflare ? true : isManualTunnel ? state.useHttps : false,
      tunnel_provider: state.tunnelProvider,
      cloudflared_auto_start: isManagedCloudflare ? state.cloudflaredAutoStart : false,
      cloudflared_target_url: isManagedCloudflare ? state.cloudflaredTargetUrl : ''
    }
  }

  function handleCompressionSliderChange(value: number | number[]) {
    if (Array.isArray(value)) {
      clipSettings.compressionQuality = value[0] ?? clipSettings.compressionQuality
    } else {
      clipSettings.compressionQuality = value
    }
  }

  async function loadCloudflaredStatus() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/tunnel')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Cloudflare tunnel status')
        throw new Error(message)
      }

      const payload = (await response.json()) as CloudflaredTunnelStatus
      cloudflaredStatus = payload
      if (typeof payload.autoStart === 'boolean') {
        clipSettings.cloudflaredAutoStart = payload.autoStart
      }
      if (typeof payload.targetUrl === 'string' && payload.targetUrl.trim().length > 0) {
        clipSettings.cloudflaredTargetUrl = payload.targetUrl.trim()
      }
      if (clipSettings.tunnelProvider === 'cloudflared_managed') {
        clipSettings.tunnelUrl = payload?.tunnel?.publicUrl ?? ''
      }
    } catch (error) {
      console.error('[ClipSettings] Failed to load Cloudflare tunnel status:', error)
      cloudflaredError =
        error instanceof Error ? error.message : 'Failed to load Cloudflare tunnel status'
    } finally {
      cloudflaredBusy = false
    }
  }

  async function startManagedTunnel() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          targetUrl: clipSettings.cloudflaredTargetUrl,
          autoStart: clipSettings.cloudflaredAutoStart
        })
      })
      const payload = (await response.json().catch(() => null)) as CloudflaredTunnelStatus | null
      if (!response.ok) {
        throw new Error(payload?.reason || payload?.error || 'Failed to start Cloudflare tunnel')
      }
      cloudflaredStatus = payload
      clipSettings.tunnelUrl = payload?.tunnel?.publicUrl ?? ''
      clipSettings.useHttps = true
      toast.success('Managed Cloudflare tunnel started')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start Cloudflare tunnel'
      cloudflaredError = message
      toast.error(message)
    } finally {
      cloudflaredBusy = false
    }
  }

  async function stopManagedTunnel() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      })
      const payload = (await response.json().catch(() => null)) as CloudflaredTunnelStatus | null
      if (!response.ok) {
        throw new Error(payload?.reason || payload?.error || 'Failed to stop Cloudflare tunnel')
      }
      cloudflaredStatus = payload
      clipSettings.tunnelUrl = ''
      toast.success('Managed Cloudflare tunnel stopped')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to stop Cloudflare tunnel'
      cloudflaredError = message
      toast.error(message)
    } finally {
      cloudflaredBusy = false
    }
  }

  async function updateManagedAutoStart(enabled: boolean) {
    clipSettings.cloudflaredAutoStart = enabled
    cloudflaredError = null
    try {
      const response = await fetch('/api/native-tools/cloudflared/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set-auto-start',
          enabled,
          targetUrl: clipSettings.cloudflaredTargetUrl
        })
      })
      const payload = (await response.json().catch(() => null)) as CloudflaredTunnelStatus | null
      if (!response.ok) {
        throw new Error(payload?.reason || payload?.error || 'Failed to update auto-start')
      }
      cloudflaredStatus = payload
      if (enabled && payload?.tunnel?.publicUrl) {
        clipSettings.tunnelUrl = payload.tunnel.publicUrl
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update auto-start'
      cloudflaredError = message
      toast.error(message)
    }
  }

  function handleTunnelProviderChange(value: string | string[]) {
    const next = Array.isArray(value) ? value[0] : value
    const tunnelProvider =
      next === 'cloudflared_managed'
        ? 'cloudflared_managed'
        : next === 'manual'
          ? 'manual'
          : 'none'
    clipSettings.tunnelProvider = tunnelProvider

    if (tunnelProvider === 'cloudflared_managed') {
      clipSettings.useHttps = true
      void loadCloudflaredStatus()
      return
    }

    if (tunnelProvider === 'none') {
      clipSettings.tunnelUrl = ''
      cloudflaredError = null
      return
    }

    if (clipSettings.tunnelUrl.startsWith('https://')) {
      clipSettings.useHttps = true
    }
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json()
      return data?.error || data?.message || fallback
    } catch {
      return fallback
    }
  }

</script>

{#if isLoading}
  <div class="flex items-center justify-center p-12">
    <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    <span class="ml-2 text-sm text-muted-foreground">Loading clip settings…</span>
  </div>
{:else}
  <div class="batshit-settings-surface">
    <div class="space-y-4">
      <div class="flex min-w-0 items-center gap-1.5">
        <Paperclip class="h-4 w-4" />
        <h3 class="batshit-settings-section-title">Clips</h3>
        <SettingsInfoMenu ariaLabel="About Clip Settings" contentClass="w-80">
          <p>
            Clips control how uploaded images are optimized, where they are stored, and how Batshit
            sends them as structured image inputs instead of prompt text.
          </p>
        </SettingsInfoMenu>
      </div>

      <SettingsAccordionCard name="clip-settings-cards" title="Image Optimization" icon={Image} open>
        {#snippet info()}
            <SettingsInfoMenu ariaLabel="About Image Optimization" contentClass="w-80">
              <p>
                These controls shrink image uploads before they become clips so token use stays
                low without making screenshots unreadable.
              </p>
            </SettingsInfoMenu>
        {/snippet}
        {#snippet actions()}
          <SettingsSaveStatus
            state={activeSaveScope === 'image' ? (saveError ? 'error' : saveState) : 'idle'}
            error={activeSaveScope === 'image' ? saveError : null}
            savedLabel="Saved"
            sticky={false}
          />
        {/snippet}
          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-toggle-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label.Root class="batshit-settings-form-label">Resize &amp; Compress Images</Label.Root>
                  <SettingsInfoMenu ariaLabel="About Resize and Compress Images">
                    <p>
                      Turn Batshit’s automatic image shrinking on or off. Most screenshots should keep
                      this enabled.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="batshit-settings-form-label">
                  {clipSettings.compressImages ? 'Enabled' : 'Disabled'}
                </span>
                <Switch.Root bind:checked={clipSettings.compressImages} />
              </div>
            </div>

            {#if clipSettings.compressImages}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label">Compression Quality</Label.Root>
                    <SettingsInfoMenu ariaLabel="About Compression Quality">
                      <p>
                        Lower values shrink file size more aggressively. Around 40% usually works
                        well for screenshots.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <div class="flex items-center gap-3">
                    <Slider
                      type="single"
                      value={clipSettings.compressionQuality}
                      onValueChange={handleCompressionSliderChange}
                      min={10}
                      max={100}
                      step={5}
                      class="w-full"
                    />
                    <span class="min-w-9 text-right text-xs text-muted-foreground">
                      {clipSettings.compressionQuality}%
                    </span>
                  </div>
                </div>
              </div>

              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label">Maximum Image Size</Label.Root>
                    <SettingsInfoMenu ariaLabel="About Maximum Image Size">
                      <p>
                        Larger images are resized down to this maximum dimension before Batshit stores
                        them.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <Select.Root type="single" bind:value={clipSettings.maxImageSize}>
                    <Select.Trigger>
                      {IMAGE_SIZE_OPTIONS.find((option) => option.value === clipSettings.maxImageSize)?.label || 'Select max size'}
                    </Select.Trigger>
                    <Select.Content>
                      {#each IMAGE_SIZE_OPTIONS as option}
                        <Select.Item value={option.value} label={option.label}>
                          {option.label}
                        </Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>

              <div class="batshit-settings-toggle-row is-child">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-child-label">Always Convert to JPEG</Label.Root>
                    <SettingsInfoMenu ariaLabel="About Always Convert to JPEG">
                      <p>
                        This gives the strongest compression, but it can soften crisp text. Leave it
                        off for diagrams or extra-sharp UI screenshots.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <Switch.Root bind:checked={clipSettings.forceJpeg} />
              </div>
            {/if}
          </div>
      </SettingsAccordionCard>

          <SettingsAccordionCard name="clip-settings-cards" title="Tunnel Access" batshitIcon="tunnel">
            {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Tunnel Access" contentClass="w-80">
                  <p>
                    Local clips need a reachable URL when a model has to fetch the image. Manual or
                    managed tunnels let Batshit swap in the current public URL at send time.
                  </p>
                </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              <SettingsSaveStatus
                state={activeSaveScope === 'local' ? (saveError ? 'error' : saveState) : 'idle'}
                error={activeSaveScope === 'local' ? saveError : null}
                savedLabel="Saved"
                sticky={false}
              />
            {/snippet}
            <div class="batshit-settings-form-stack">
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label">Tunnel Provider</Label.Root>
                      <SettingsInfoMenu ariaLabel="About Tunnel Provider">
                        <p>
                        Choose None when you want clips sent as structured data URLs without a
                        public tunnel. Use manual or managed tunnels when a runtime needs URL access.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    value={clipSettings.tunnelProvider}
                    onValueChange={handleTunnelProviderChange}
                  >
                    <Select.Trigger>
                      {clipSettings.tunnelProvider === 'cloudflared_managed'
                        ? 'Managed Cloudflare tunnel'
                        : clipSettings.tunnelProvider === 'manual'
                          ? 'Manual tunnel URL'
                          : 'None'}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="none" label="None">
                        None
                      </Select.Item>
                      <Select.Item value="manual" label="Manual tunnel URL">
                        Manual tunnel URL (ngrok / Cloudflare / custom)
                      </Select.Item>
                      <Select.Item value="cloudflared_managed" label="Managed Cloudflare">
                        Managed Cloudflare tunnel (trycloudflare URL)
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>

              {#if clipSettings.tunnelProvider === 'manual'}
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Root for="tunnel-url" class="batshit-settings-form-label">Tunnel URL</Label.Root>
                      <SettingsInfoMenu ariaLabel="About Tunnel URL" contentClass="w-80">
                        <p>
                          Batshit resolves reusable clips against whatever URL is saved here at send
                          time, so changing the URL later does not force you to re-upload older clips.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Input
                      id="tunnel-url"
                      bind:value={clipSettings.tunnelUrl}
                      placeholder="abc123.ngrok.io or my-tunnel.example.com"
                      class="font-mono text-xs"
                    />
                  </div>
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Root for="use-https" class="batshit-settings-form-label">Use HTTPS Protocol</Label.Root>
                      <SettingsInfoMenu ariaLabel="About Use HTTPS Protocol">
                        <p>
                          Leave this on when your tunnel already serves HTTPS. Batshit also detects
                          <code>https://</code> automatically when you paste a full tunnel URL.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root id="use-https" bind:checked={clipSettings.useHttps} />
                </div>
              {/if}

            {#if clipSettings.tunnelProvider === 'cloudflared_managed'}
              <div class="batshit-settings-tunnel-managed-panel space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="space-y-1">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Managed Cloudflare Tunnel</p>
                      <SettingsInfoMenu ariaLabel="About Managed Cloudflare Tunnel" contentClass="w-80">
                        <p>
                          {#if cloudflaredStatus?.supportLevel === 'docker-sidecar'}
                            Docker Batshit runs Cloudflared as an optional sidecar and resolves
                            reusable clip URLs from the live public address.
                          {:else}
                            Batshit runs <code>cloudflared tunnel --url {clipSettings.cloudflaredTargetUrl}</code> and
                            resolves reusable clip URLs from the live public address instead of
                            freezing an old tunnel host forever.
                          {/if}
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Badge variant={cloudflaredStatus?.tunnel?.running ? 'secondary' : 'outline'}>
                    {cloudflaredStatus?.supportLevel === 'docker-sidecar' && cloudflaredStatus?.tunnel?.running
                      ? 'Sidecar Running'
                      : cloudflaredStatus?.supportLevel === 'docker-sidecar'
                        ? cloudflaredStatus?.dockerSidecar?.status === 'starting'
                          ? 'Sidecar Starting'
                          : 'Sidecar Stopped'
                        : cloudflaredStatus?.tunnel?.running
                          ? 'Running'
                          : 'Stopped'}
                  </Badge>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onclick={cloudflaredStatus?.tunnel?.running ? stopManagedTunnel : startManagedTunnel}
                    disabled={
                      cloudflaredBusy ||
                      (cloudflaredStatus?.installed === false &&
                        cloudflaredStatus?.supportLevel !== 'docker-sidecar')
                    }
                  >
                    {cloudflaredBusy
                      ? cloudflaredStatus?.tunnel?.running
                        ? 'Stopping…'
                        : 'Starting…'
                      : cloudflaredStatus?.tunnel?.running
                        ? 'Stop Tunnel'
                        : 'Start Tunnel'}
                  </Button>
                  <Button size="sm" variant="outline" onclick={loadCloudflaredStatus} disabled={cloudflaredBusy}>
                    <RefreshCw class={`${cloudflaredBusy ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                </div>

                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root for="cloudflared-target-url" class="batshit-settings-form-label">
                          {cloudflaredStatus?.supportLevel === 'docker-sidecar' ? 'Internal Target URL' : 'Target URL'}
                        </Label.Root>
                        <SettingsInfoMenu ariaLabel="About Cloudflared Target URL">
                          <p>
                            {#if cloudflaredStatus?.supportLevel === 'docker-sidecar'}
                              This is the Docker Compose service URL used inside the Docker network.
                              It is not your Mac or PC's localhost port.
                            {:else}
                              This is usually <code>{DEFAULT_CLOUDFLARED_TARGET_URL}</code>. Change it only if your
                              Batshit file server is reachable somewhere else.
                            {/if}
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        id="cloudflared-target-url"
                        bind:value={clipSettings.cloudflaredTargetUrl}
                        placeholder={DEFAULT_CLOUDFLARED_TARGET_URL}
                        class="font-mono text-xs"
                        disabled={cloudflaredBusy || cloudflaredStatus?.supportLevel === 'docker-sidecar'}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Auto-Start Managed Tunnel</Label.Root>
                        <SettingsInfoMenu ariaLabel="About Auto-Start Managed Tunnel">
                          <p>
                            When enabled, Batshit will try to bring the managed tunnel up
                            automatically whenever clip uploads need a public URL.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <Switch.Root
                      checked={clipSettings.cloudflaredAutoStart}
                      onCheckedChange={(checked) => updateManagedAutoStart(Boolean(checked))}
                      disabled={cloudflaredBusy}
                    />
                  </div>
                </div>

                {#if cloudflaredStatus?.tunnel?.publicUrl}
                  <p class="text-xs text-muted-foreground break-all">
                    Public URL: <code>{cloudflaredStatus.tunnel.publicUrl}</code>
                  </p>
                {/if}
                {#if cloudflaredStatus?.supportLevel === 'docker-sidecar'}
                  <p class="batshit-settings-form-help">
                    Docker sidecar target: <code>{clipSettings.cloudflaredTargetUrl}</code>.
                    This is internal to Docker Compose, so it does not collide with host ports.
                    Batshit uses the current public URL when clips need it.
                  </p>
                {:else if cloudflaredStatus?.dockerUnsupported}
                  <p class="batshit-settings-form-help is-danger">
                    {cloudflaredStatus.reason || 'Managed Cloudflared is not available in this Docker runtime yet.'}
                  </p>
                {:else if cloudflaredStatus?.installed === false}
                  <p class="batshit-settings-form-help is-danger">
                    Cloudflared is not installed. Install it in Settings -> Admin -> Cloudflared Runtime.
                  </p>
                {/if}
                {#if cloudflaredError}
                  <p class="batshit-settings-form-help is-danger">{cloudflaredError}</p>
                {/if}
              </div>
            {/if}
            </div>
          </SettingsAccordionCard>
    </div>
  </div>
{/if}
