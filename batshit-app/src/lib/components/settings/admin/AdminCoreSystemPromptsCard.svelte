<script lang="ts">
  import { AlertCircle, FileText, Loader2, RefreshCw } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { formatBackupDate, type CoreSystemPromptSummary } from './adminSettingsTypes'

  interface Props {
    prompts: CoreSystemPromptSummary[]
    loading: boolean
    error: string | null
    busyId: string | null
    onRetry: () => void
    onEdit: (id: string) => void
    onReset: (prompt: CoreSystemPromptSummary) => void
  }

  let { prompts, loading, error, busyId, onRetry, onEdit, onReset }: Props = $props()
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Core System Prompts"
  icon={FileText}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Core System Prompts" contentClass="w-96">
      <p>
        These prompts are the default instructions Batshit gives its primary agents, subagents,
        Dynamic MCP, and tool/zip guidance. Edit only when you intentionally want to change core
        behavior.
      </p>
    </SettingsInfoMenu>
  {/snippet}

  <div class="batshit-settings-inline-alert is-danger flex items-start gap-3">
    <AlertCircle class="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    <div>
      <div class="batshit-settings-inline-strong">Core prompt edits are powerful</div>
      <p class="mt-1 text-sm text-muted-foreground">
        A bad edit can break tools, zips, skills, artifacts, voice, and agent behavior. Every
        prompt can be reset to the packaged Batshit default.
      </p>
    </div>
  </div>

  {#if loading}
    <div class="batshit-settings-caption">Loading core system prompts...</div>
  {:else if error}
    <div class="batshit-settings-inline-alert is-danger flex items-center gap-2">
      <AlertCircle class="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <span>{error}</span>
    </div>
    <Button type="button" size="sm" variant="outline" onclick={onRetry}>
      <RefreshCw aria-hidden="true" />
      Retry
    </Button>
  {:else}
    <div class="space-y-2">
      {#each prompts as prompt (prompt.id)}
        <div class="batshit-settings-muted-panel">
          <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="batshit-settings-child-label">{prompt.label}</span>
                {#if prompt.matchesDefault}
                  <Badge variant="outline" class="core-prompt-status-badge is-default">
                    Batshit default
                  </Badge>
                {:else}
                  <Badge variant="outline" class="core-prompt-status-badge is-customized">
                    Customized
                  </Badge>
                {/if}
                {#if prompt.newDefaultAvailable}
                  <Badge variant="outline">New default available</Badge>
                {/if}
              </div>
              <p class="text-xs text-muted-foreground">{prompt.description}</p>
              <div class="batshit-settings-caption">
                {prompt.redisKey} / {prompt.defaultFile}
                {#if prompt.lastUpdated}
                  / Updated {formatBackupDate(prompt.lastUpdated)}
                {/if}
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onclick={() => onEdit(prompt.id)}
                disabled={busyId !== null}
              >
                {#if busyId === prompt.id}
                  <Loader2 class="animate-spin" aria-hidden="true" />
                {:else}
                  <FileText aria-hidden="true" />
                {/if}
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onclick={() => onReset(prompt)}
                disabled={prompt.matchesDefault || busyId !== null}
              >
                <RefreshCw aria-hidden="true" />
                Reset
              </Button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</SettingsAccordionCard>
