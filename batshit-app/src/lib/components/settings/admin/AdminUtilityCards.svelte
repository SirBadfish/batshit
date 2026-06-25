<script lang="ts">
  import { Sparkles, Workflow } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import { Input } from '$lib/components/ui/input'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    DEFAULT_N8N_EXECUTION_SEARCH_LIMIT,
    MAX_N8N_EXECUTION_SEARCH_LIMIT,
    clampNumber
  } from './adminSettingsTypes'

  interface Props {
    goonLipSyncLabEnabled: boolean
    n8nExecutionSearchLimit: number
    disabled: boolean
    onGoonLipSyncLabEnabledChange: (checked: boolean) => void
    onN8nExecutionSearchLimitChange: (value: number) => void
  }

  let {
    goonLipSyncLabEnabled,
    n8nExecutionSearchLimit,
    disabled,
    onGoonLipSyncLabEnabledChange,
    onN8nExecutionSearchLimitChange
  }: Props = $props()
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Goon Dock Utilities"
  icon={Sparkles}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Goon Dock Utilities" contentClass="w-80">
      <p>
        Optional diagnostic/user utilities that appear inside the Goon Dock. They use the same saved
        settings as the full Voice and 3D Goons panels.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="goon-lip-sync-lab-enabled">
            Lip Sync Lab
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Lip Sync Lab">
            <p>
              Shows the compact Lip Sync Lab at the top of the Goon Dock. It edits the same global
              lip sync mode and analyzer settings as Voice Settings.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control is-inline-status">
        <Switch.Root
          id="goon-lip-sync-lab-enabled"
          checked={goonLipSyncLabEnabled}
          onCheckedChange={(checked) => onGoonLipSyncLabEnabledChange(checked === true)}
          disabled={disabled}
        />
      </div>
    </div>
  </div>
</SettingsAccordionCard>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Execution Viewer"
  icon={Workflow}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Execution Viewer">
      <p>
        Controls how Batshit looks up real n8n executions when hydrating
        <code>Webhook Input (n8n-style)</code> for n8n primary-agent runs.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="n8n-execution-search-limit">
            n8n Execution Search Limit
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About n8n Execution Search Limit">
            <p>
              Default {DEFAULT_N8N_EXECUTION_SEARCH_LIMIT}. Higher values improve hydration
              reliability, but they also make the lookup slower. Maximum is
              {MAX_N8N_EXECUTION_SEARCH_LIMIT}.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="n8n-execution-search-limit"
          type="number"
          min="1"
          max={MAX_N8N_EXECUTION_SEARCH_LIMIT}
          step="1"
          value={n8nExecutionSearchLimit}
          oninput={(event) =>
            onN8nExecutionSearchLimitChange(
              clampNumber(
                (event.target as HTMLInputElement).value,
                1,
                MAX_N8N_EXECUTION_SEARCH_LIMIT
              )
            )}
          disabled={disabled}
        />
      </div>
    </div>
  </div>
</SettingsAccordionCard>
