<script lang="ts">
  import { BellRing } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import AdminWakeHooksSection from '$lib/components/settings/admin/AdminWakeHooksSection.svelte'

  // SA-113 P1 (DL-113-01): the instance-wide master switch for wake-ups.
  // SA-113 P3 (DL-113-09): the "Wake-up webhooks" list lives under it, in the same card,
  // because the master switch is what turns every one of those hooks into a wait.
  interface Props {
    agentWakeupsEnabled: boolean
    disabled: boolean
    onAgentWakeupsEnabledChange: (checked: boolean) => void
  }

  let { agentWakeupsEnabled, disabled, onAgentWakeupsEnabledChange }: Props = $props()
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Agent Wake-ups"
  icon={BellRing}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Agent Wake-ups" contentClass="w-80">
      <p>
        A wake-up is a chat Batshit starts on its own, with nobody typing. One agent can send
        another a message and ask for the work to start now, and an outside program can do the
        same through a wake-up webhook.
      </p>
      <p>
        Woken chats are ordinary chats: they appear in the sidebar with a small icon showing what
        started them, they cost tokens like any chat, and they have the normal Stop button.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="agent-wakeups-enabled">
            Allow Wake-ups
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Allow Wake-ups">
            <p>
              The master switch for this Batshit. Turn it off and nothing can start a chat on its
              own: every wake-up waits in the recipient's inbox instead, with the reason recorded.
            </p>
            <p>Each agent also has its own "May be woken" switch in Agent Settings.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control is-inline-status">
        <Switch.Root
          id="agent-wakeups-enabled"
          checked={agentWakeupsEnabled}
          onCheckedChange={(checked) => onAgentWakeupsEnabledChange(checked === true)}
          disabled={disabled}
        />
      </div>
    </div>
  </div>

  <AdminWakeHooksSection {disabled} />
</SettingsAccordionCard>
