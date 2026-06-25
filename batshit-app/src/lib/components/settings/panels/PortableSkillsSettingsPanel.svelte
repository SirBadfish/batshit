<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { Check, Copy, Download, KeyRound, Loader2, Plus, RefreshCw, RotateCw, Trash2 } from '@lucide/svelte'
  import type {
    PortableSkillEnvTemplateInfo,
    PortableSkillFamilyId,
    PortableSkillTokenFamilyDefinition,
    PortableSkillTokenSummary
  } from '$lib/types/portableSkills'

  type TokensResponse = {
    success?: boolean
    tokens?: PortableSkillTokenSummary[]
    families?: PortableSkillTokenFamilyDefinition[]
    envTemplates?: PortableSkillEnvTemplateInfo[]
    token?: string
    record?: PortableSkillTokenSummary
    error?: string
  }

  type PortableSkillInstallCard = {
    id: string
    title: string
    family: PortableSkillFamilyId
    summary: string
    zipUrl: string
  }

  interface Props {
    embedded?: boolean
  }

  let { embedded = false }: Props = $props()

  let tokens = $state<PortableSkillTokenSummary[]>([])
  let families = $state<PortableSkillTokenFamilyDefinition[]>([])
  let envTemplates = $state<PortableSkillEnvTemplateInfo[]>([])
  let loading = $state(false)
  let busyTokenId = $state<string | null>(null)
  let createBusy = $state(false)
  let error = $state<string | null>(null)
  let newLabel = $state('')
  let selectedFamilies = $state<PortableSkillFamilyId[]>([])
  let createDialogOpen = $state(false)
  let revealDialogOpen = $state(false)
  let revealedToken = $state('')
  let revealedLabel = $state('')
  let revealedFamilies = $state<PortableSkillFamilyId[]>([])
  let copied = $state(false)
  let copiedEnvSnippet = $state(false)
  let copiedInstallSkillId = $state<string | null>(null)

  const tokenCount = $derived(tokens.filter((token) => !token.revokedAt).length)
  const portableSkillInstallCards: PortableSkillInstallCard[] = [
    {
      id: 'voice-engine-installer',
      title: 'Voice Engine Installer',
      family: 'voice-engines',
      summary: 'Installs, registers, health-checks, and enables local speech engines.',
      zipUrl: 'https://docs.batshit.ai/portable-skills/voice-engine-installer.zip'
    },
    {
      id: 'artifact-creator',
      title: 'Artifact Creator',
      family: 'artifacts',
      summary: 'Creates, validates, patches, publishes, and places Batshit artifacts.',
      zipUrl: 'https://docs.batshit.ai/portable-skills/artifact-creator.zip'
    },
    {
      id: 'cli-tool-creator',
      title: 'CLI Tool Creator',
      family: 'cli-tools',
      summary: 'Creates, updates, tests, archives, and deletes Batshit CLI tools.',
      zipUrl: 'https://docs.batshit.ai/portable-skills/cli-tool-creator.zip'
    },
    {
      id: 'skill-creator',
      title: 'Skill Creator',
      family: 'skills',
      summary: 'Saves and imports Batshit skills from an outside coding agent.',
      zipUrl: 'https://docs.batshit.ai/portable-skills/skill-creator.zip'
    }
  ]

  function formatDate(value: string | null) {
    if (!value) return 'Never'
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(value))
    } catch {
      return value
    }
  }

  function familyLabel(familyId: string) {
    return families.find((family) => family.id === familyId)?.label ?? familyId
  }

  function familyControlCount(familyId: string) {
    return families.find((family) => family.id === familyId)?.controlIds.length ?? null
  }

  function tokenMask(token: PortableSkillTokenSummary) {
    return `...${token.tokenSuffix.slice(-4)}`
  }

  function toggleFamily(familyId: PortableSkillFamilyId) {
    if (selectedFamilies.includes(familyId)) {
      selectedFamilies = selectedFamilies.filter((id) => id !== familyId)
      return
    }
    selectedFamilies = [...selectedFamilies, familyId]
  }

  function openCreateDialog() {
    error = null
    newLabel = ''
    selectedFamilies = []
    createDialogOpen = true
  }

  function installPrompt(skill: PortableSkillInstallCard) {
    return `Install the Batshit Portable ${skill.title} skill from ${skill.zipUrl}. Use credentials from ~/.batshit/portable-skills/portable-skills.env.`
  }

  function setResponseState(payload: TokensResponse) {
    tokens = payload.tokens ?? (payload.record ? upsertToken(tokens, payload.record) : tokens)
    families = payload.families ?? families
    envTemplates = payload.envTemplates ?? envTemplates
  }

  function upsertToken(rows: PortableSkillTokenSummary[], token: PortableSkillTokenSummary) {
    const next = rows.filter((row) => row.id !== token.id)
    if (!token.revokedAt) next.unshift(token)
    return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async function loadTokens() {
    loading = true
    error = null
    try {
      const response = await fetch('/api/portable-skills/tokens')
      const payload = (await response.json()) as TokensResponse
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || 'Could not load Portable Skill Tokens.')
      }
      tokens = payload.tokens ?? []
      families = payload.families ?? []
      envTemplates = payload.envTemplates ?? []
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load Portable Skill Tokens.'
    } finally {
      loading = false
    }
  }

  async function createToken() {
    createBusy = true
    error = null
    try {
      const response = await fetch('/api/portable-skills/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newLabel,
          families: selectedFamilies
        })
      })
      const payload = (await response.json()) as TokensResponse
      if (!response.ok || payload.success === false || !payload.token || !payload.record) {
        throw new Error(payload.error || 'Could not create Portable Skill Token.')
      }
      setResponseState(payload)
      revealedToken = payload.token
      revealedLabel = payload.record.label
      revealedFamilies = payload.record.families
      createDialogOpen = false
      revealDialogOpen = true
      copied = false
      copiedEnvSnippet = false
      newLabel = ''
      selectedFamilies = []
      toast.success('Portable Skill Token created')
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create Portable Skill Token.'
      toast.error(error)
    } finally {
      createBusy = false
    }
  }

  async function rotateToken(token: PortableSkillTokenSummary) {
    busyTokenId = token.id
    error = null
    try {
      const response = await fetch(`/api/portable-skills/tokens/${encodeURIComponent(token.id)}/rotate`, {
        method: 'POST'
      })
      const payload = (await response.json()) as TokensResponse
      if (!response.ok || payload.success === false || !payload.token || !payload.record) {
        throw new Error(payload.error || 'Could not rotate Portable Skill Token.')
      }
      setResponseState(payload)
      revealedToken = payload.token
      revealedLabel = payload.record.label
      revealedFamilies = payload.record.families
      revealDialogOpen = true
      copied = false
      copiedEnvSnippet = false
      toast.success('Portable Skill Token rotated')
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not rotate Portable Skill Token.'
      toast.error(error)
    } finally {
      busyTokenId = null
    }
  }

  async function revokeToken(token: PortableSkillTokenSummary) {
    const confirmed = await confirmDialog({
      title: `Revoke ${token.label}?`,
      description: 'This token will stop working immediately for every Portable Skill that uses it.',
      confirmLabel: 'Revoke Token',
      tone: 'destructive'
    })
    if (!confirmed) return
    busyTokenId = token.id
    error = null
    try {
      const response = await fetch(`/api/portable-skills/tokens/${encodeURIComponent(token.id)}`, {
        method: 'DELETE'
      })
      const payload = (await response.json()) as TokensResponse
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || 'Could not revoke Portable Skill Token.')
      }
      tokens = tokens.filter((row) => row.id !== token.id)
      toast.success('Portable Skill Token revoked')
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not revoke Portable Skill Token.'
      toast.error(error)
    } finally {
      busyTokenId = null
    }
  }

  async function copyRevealedToken() {
    try {
      await copyTextToClipboard(revealedToken)
      copied = true
      toast.success('Token copied')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy token.')
    }
  }

  function envSnippet() {
    return `BATSHIT_BASE_URL=http://127.0.0.1:5620\nBATSHIT_PORTABLE_TOKEN=${revealedToken}\n`
  }

  function revealedEnvTemplates() {
    return envTemplates.filter(
      (template) => template.kind === 'shared' || (template.family && revealedFamilies.includes(template.family))
    )
  }

  async function copyEnvSnippet() {
    try {
      await copyTextToClipboard(envSnippet())
      copiedEnvSnippet = true
      toast.success('Env snippet copied')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy env snippet.')
    }
  }

  async function copyInstallPrompt(skill: PortableSkillInstallCard) {
    try {
      await copyTextToClipboard(installPrompt(skill))
      copiedInstallSkillId = skill.id
      toast.success('Install prompt copied')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy install prompt.')
    }
  }

  onMount(() => {
    void loadTokens()
  })
</script>

<div class={embedded ? 'flex w-full flex-col gap-4' : 'mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-6'}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-xl font-semibold tracking-normal">Portable Skills</h2>
      <p class="text-sm text-muted-foreground">{tokenCount} active token{tokenCount === 1 ? '' : 's'}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" onclick={openCreateDialog}>
        <Plus class="size-4" aria-hidden="true" />
        Create Portable Skill Token
      </Button>
      <Button type="button" variant="outline" size="sm" onclick={loadTokens} disabled={loading}>
        {#if loading}
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {:else}
          <RefreshCw class="size-4" aria-hidden="true" />
        {/if}
        Refresh
      </Button>
    </div>
  </div>

  {#if error}
    <div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>
  {/if}

  <div class="grid gap-3 md:grid-cols-2">
    {#each portableSkillInstallCards as skill}
      <Card.Root>
        <Card.Content class="grid h-full gap-4 p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-base font-medium">{skill.title}</h3>
                <Badge variant="outline">{familyLabel(skill.family)}</Badge>
                {#if familyControlCount(skill.family) !== null}
                  <Badge variant="secondary">{familyControlCount(skill.family)} controls</Badge>
                {/if}
              </div>
              <p class="text-sm text-muted-foreground">{skill.summary}</p>
            </div>
            <Download class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>

          <div class="grid gap-2 rounded-md border bg-muted/20 p-3">
            <div class="text-xs font-medium uppercase tracking-normal text-muted-foreground">Install prompt</div>
            <code class="break-words text-xs leading-relaxed">{installPrompt(skill)}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="justify-self-start"
              onclick={() => copyInstallPrompt(skill)}
            >
              {#if copiedInstallSkillId === skill.id}
                <Check class="size-4" aria-hidden="true" />
                Copied
              {:else}
                <Copy class="size-4" aria-hidden="true" />
                Copy install prompt
              {/if}
            </Button>
          </div>
        </Card.Content>
      </Card.Root>
    {/each}
  </div>

  <div class="grid gap-3">
    <div class="flex items-center justify-between gap-3">
      <h3 class="text-base font-semibold tracking-normal">Tokens</h3>
      <span class="text-sm text-muted-foreground">{tokenCount} active</span>
    </div>
    {#if loading && tokens.length === 0}
      <div class="flex min-h-28 items-center justify-center rounded-md border text-sm text-muted-foreground">
        <Loader2 class="mr-2 size-4 animate-spin" aria-hidden="true" />
        Loading tokens...
      </div>
    {:else if tokens.length === 0}
      <div class="rounded-md border p-4 text-sm text-muted-foreground">No Portable Skill Tokens yet.</div>
    {:else}
      {#each tokens as token}
        <Card.Root>
          <Card.Content class="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="truncate text-base font-medium">{token.label}</h3>
                <Badge variant="secondary">{tokenMask(token)}</Badge>
              </div>
              <div class="flex flex-wrap gap-2">
                {#each token.families as familyId}
                  <Badge variant="outline">{familyLabel(familyId)}</Badge>
                {/each}
              </div>
              <p class="text-xs text-muted-foreground">
                Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)}
              </p>
            </div>
            <div class="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={() => rotateToken(token)}
                disabled={busyTokenId === token.id}
                title="Rotate token"
              >
                {#if busyTokenId === token.id}
                  <Loader2 class="size-4 animate-spin" aria-hidden="true" />
                {:else}
                  <RotateCw class="size-4" aria-hidden="true" />
                {/if}
                Rotate
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onclick={() => revokeToken(token)}
                disabled={busyTokenId === token.id}
                title="Revoke token"
              >
                <Trash2 class="size-4" aria-hidden="true" />
                Revoke
              </Button>
            </div>
          </Card.Content>
        </Card.Root>
      {/each}
    {/if}
  </div>
</div>

<Dialog.Root bind:open={createDialogOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Create Portable Skill Token</Dialog.Title>
      <Dialog.Description>Choose the Portable Skills this token is allowed to operate.</Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      {#if error}
        <div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      {/if}

      <div class="grid gap-2">
        <Label for="portable-token-label">Label</Label>
        <Input
          id="portable-token-label"
          bind:value={newLabel}
          maxlength={80}
          autocomplete="off"
        />
      </div>

      <div class="grid gap-2">
        <Label>Scopes</Label>
        {#if families.length === 0}
          <div class="flex min-h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            <Loader2 class="mr-2 size-4 animate-spin" aria-hidden="true" />
            Loading scopes...
          </div>
        {:else}
          <div class="grid gap-2 md:grid-cols-2">
            {#each families as family}
              <button
                type="button"
                class="flex min-h-16 cursor-pointer items-start gap-3 rounded-md border p-3 text-left transition hover:bg-muted/50"
                onclick={() => toggleFamily(family.id)}
              >
                <Checkbox
                  checked={selectedFamilies.includes(family.id)}
                  class=""
                  aria-label={family.label}
                />
                <span class="grid gap-1">
                  <span class="text-sm font-medium">{family.label}</span>
                  <span class="text-xs text-muted-foreground">{family.controlIds.length} controls</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => (createDialogOpen = false)}>
        Cancel
      </Button>
      <Button type="button" onclick={createToken} disabled={createBusy || selectedFamilies.length === 0}>
        {#if createBusy}
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {:else}
          <KeyRound class="size-4" aria-hidden="true" />
        {/if}
        Create Token
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={revealDialogOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{revealedLabel}</Dialog.Title>
      <Dialog.Description>Copy this token now. Batshit will not show it again.</Dialog.Description>
    </Dialog.Header>
    <div class="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
      {revealedToken}
    </div>
    <div class="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm">
      <div class="font-medium">Private env file option</div>
      {#if revealedEnvTemplates().length > 0}
        <p class="text-muted-foreground">
          Paste the snippet below into the shared private file. One multi-scope token can power all
          Portable Skills from that file; use per-skill env files only when you want narrower tokens.
          Batshit creates the shared placeholder automatically on Mac/native installs; Docker users
          should save the text on the host.
        </p>
        <div class="grid gap-1 text-xs">
          {#each revealedEnvTemplates() as template}
            <div class="rounded border bg-background/70 p-2">
              <div class="font-medium">{template.label}</div>
              <div class="break-all font-mono text-muted-foreground">{template.path}</div>
              <div class="mt-1 text-muted-foreground">
                {#if template.writable}
                  {template.created ? 'Placeholder created.' : 'Placeholder available.'}
                {:else}
                  Save this file on the host for Docker.
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
      <pre class="overflow-x-auto rounded border bg-background p-2 text-xs"><code>{envSnippet()}</code></pre>
    </div>
    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={copyRevealedToken}>
        {#if copied}
          <Check class="size-4" aria-hidden="true" />
          Copied
        {:else}
          <Copy class="size-4" aria-hidden="true" />
          Copy
        {/if}
      </Button>
      <Button type="button" variant="outline" onclick={copyEnvSnippet}>
        {#if copiedEnvSnippet}
          <Check class="size-4" aria-hidden="true" />
          Snippet copied
        {:else}
          <Copy class="size-4" aria-hidden="true" />
          Copy .env snippet
        {/if}
      </Button>
      <Button type="button" onclick={() => (revealDialogOpen = false)}>Done</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
