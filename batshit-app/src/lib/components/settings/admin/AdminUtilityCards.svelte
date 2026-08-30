<script lang="ts">
  import { Sparkles } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  interface Props {
    goonLipSyncLabEnabled: boolean
    disabled: boolean
    onGoonLipSyncLabEnabledChange: (checked: boolean) => void
  }

  let {
    goonLipSyncLabEnabled,
    disabled,
    onGoonLipSyncLabEnabledChange
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
