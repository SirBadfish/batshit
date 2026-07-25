<script lang="ts">
  import * as Switch from '$lib/components/ui/switch'
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import {
    SOCKET_EYE_CONTACT_CONVERGENCE_MAX,
    SOCKET_EYE_CONTACT_CONVERGENCE_MIN,
    type SocketEyeContactSettingsV2
  } from '$lib/goons/socketEyeContact'

  type Props = {
    value: SocketEyeContactSettingsV2
    disabled?: boolean
    onChange: (value: SocketEyeContactSettingsV2) => void
  }

  let { value, disabled = false, onChange }: Props = $props()

  const controls = [
    {
      id: 'strength' as const,
      label: 'Strength',
      info: 'How strongly the eyes and their natural eyelid accommodation follow the camera target. Zero leaves the authored look in control.',
      min: 0,
      max: 1,
      step: 0.01,
      fillFrom: 0,
      format: (value: number) => `${Math.round(value * 100)}%`
    },
    {
      id: 'convergence' as const,
      label: 'Gaze Convergence',
      info: 'Fine-tune how far inward both eyes aim after automatic depth-aware targeting. Positive values move inward; negative values move outward.',
      min: SOCKET_EYE_CONTACT_CONVERGENCE_MIN,
      max: SOCKET_EYE_CONTACT_CONVERGENCE_MAX,
      step: 0.01,
      fillFrom: 0,
      format: (value: number) => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`
    },
    {
      id: 'headFollow' as const,
      label: 'Head Follow',
      info: 'How much Head and Neck help when the target reaches the safe edge of the eye surface.',
      min: 0,
      max: 1,
      step: 0.01,
      fillFrom: 0,
      format: (value: number) => `${Math.round(value * 100)}%`
    },
    {
      id: 'response' as const,
      label: 'Response',
      info: 'How quickly the eyes and eyelids settle onto a new target.',
      min: 0,
      max: 1,
      step: 0.01,
      fillFrom: 0,
      format: (value: number) => `${Math.round(value * 100)}%`
    }
  ]

  function sliderValue(next: number | number[]) {
    return typeof next === 'number' ? next : next[0] ?? 0
  }

  function update(patch: Partial<SocketEyeContactSettingsV2>) {
    if (disabled) return
    onChange({ ...value, ...patch })
  }
</script>

<div class="socket-eye-contact-editor">
  <div class="batshit-settings-form-row">
    <div class="batshit-settings-form-copy">
      <GoonsFieldLabel
        label="Enabled"
        info="Let this Goon make camera-aware eye contact. Authored looks, poses, and motions still take priority."
        ariaLabel="About Eye Contact"
        class="batshit-settings-form-label-line"
      />
    </div>
    <div class="batshit-settings-form-control is-inline-status">
      <Switch.Root
        checked={value.enabled}
        onCheckedChange={(checked) => update({ enabled: checked })}
        {disabled}
        aria-label="Enable Eye Contact"
      />
    </div>
  </div>

  {#each controls as control (control.id)}
    <div class="socket-eye-contact-control">
      <div class="socket-eye-contact-label-row">
        <GoonsFieldLabel
          label={control.label}
          info={control.info}
          ariaLabel={`About ${control.label}`}
        />
        <span>{control.format(value[control.id])}</span>
      </div>
      <Slider
        type="single"
        value={value[control.id]}
        onValueChange={(next: number | number[]) => update({ [control.id]: sliderValue(next) })}
        min={control.min}
        max={control.max}
        step={control.step}
        fillFrom={control.fillFrom}
        showAnchorMarker={control.min < control.fillFrom && control.max > control.fillFrom}
        aria-label={control.label}
        {disabled}
      />
    </div>
  {/each}
</div>

<style>
  .socket-eye-contact-editor {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 14px;
    padding: 0 12px 8px;
  }

  .socket-eye-contact-control {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 7px;
  }

  .socket-eye-contact-label-row {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .socket-eye-contact-label-row > span {
    flex: 0 0 auto;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
</style>
