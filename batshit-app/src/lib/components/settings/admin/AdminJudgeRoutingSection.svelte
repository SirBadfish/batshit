<script lang="ts">
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { JudgeLaneId, JudgeProvider } from '$lib/types/typesafe'
  import { typesafeFeatureLabel } from '$lib/utils/jevJuice'
  import { JUDGE_LANE_IDS } from '$lib/utils/judgeProviders'

  /**
   * SA-120 P10a (DL-120-18) — Which Judge on the Admin Judge Juice card: the default judge every feature uses, and
   * an optional judge of its own for any of the ten features. A visible region only: the parent card owns the draft
   * and the one autosave. A choice that names a judge the list no longer holds shows as "Missing judge" and is never
   * replaced here; the save refuses it until the user picks again (the server never quietly reroutes text).
   */
  interface Props {
    judges: JudgeProvider[]
    defaultProviderId: string
    laneProviders: Partial<Record<JudgeLaneId, string>>
    disabled: boolean
    onDefaultChange: (providerId: string) => void
    onLaneChange: (lane: JudgeLaneId, providerId: string | null) => void
  }

  let { judges, defaultProviderId, laneProviders, disabled, onDefaultChange, onLaneChange }: Props = $props()

  type SelectValue = string | string[] | null | undefined
  const USE_DEFAULT = '__default__'

  function normalizeSelectValue(value: SelectValue): string {
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  }

  function judgeName(id: string | undefined): string {
    if (!id) return 'Missing judge'
    return judges.find((judge) => judge.id === id)?.label ?? 'Missing judge'
  }
</script>

<div class="batshit-settings-subsection">
  <div class="batshit-settings-action-row">
    <div class="batshit-settings-form-label-line">
      <span class="batshit-settings-parent-label">Which Judge</span>
      <SettingsInfoMenu ariaLabel="About Which Judge" contentClass="w-96">
        <p>
          Every Judge Juice feature asks the default judge unless you pick another one for it here. A feature that runs
          while your message is being sent waits at most the In-Chat Wait Limit, so a judge that is slow to start (a
          local model loading) may skip it at first.
        </p>
        <p>
          If a request is too big for the judge you picked, Batshit does not send it and the feature is skipped with a
          small note. It never cuts the request down.
        </p>
      </SettingsInfoMenu>
    </div>
  </div>

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <Label.Root class="batshit-settings-form-label" for="judge-default">Default Judge</Label.Root>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root
          type="single"
          value={defaultProviderId}
          onValueChange={(value) => {
            const next = normalizeSelectValue(value)
            if (next) onDefaultChange(next)
          }}
          disabled={disabled}
        >
          <Select.Trigger id="judge-default" class="w-full">
            <span class="truncate">{judgeName(defaultProviderId)}</span>
          </Select.Trigger>
          <Select.Content>
            {#each judges as judge (judge.id)}
              <Select.Item value={judge.id}>{judge.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>

    {#each JUDGE_LANE_IDS as lane (lane)}
      {@const chosen = laneProviders[lane]}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-child-label" for={`judge-lane-${lane}`}>{typesafeFeatureLabel(lane)}</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={chosen ?? USE_DEFAULT}
            onValueChange={(value) => {
              const next = normalizeSelectValue(value)
              onLaneChange(lane, !next || next === USE_DEFAULT ? null : next)
            }}
            disabled={disabled}
          >
            <Select.Trigger id={`judge-lane-${lane}`} class="w-full">
              <span class="truncate">{chosen ? judgeName(chosen) : `Default (${judgeName(defaultProviderId)})`}</span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={USE_DEFAULT}>Default ({judgeName(defaultProviderId)})</Select.Item>
              {#each judges as judge (judge.id)}
                <Select.Item value={judge.id}>{judge.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>
    {/each}
  </div>
</div>
