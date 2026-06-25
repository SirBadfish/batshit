<script lang="ts">
  import { Search } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import { Input } from '$lib/components/ui/input'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS,
    DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT,
    DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT,
    DEFAULT_DCM_TOOL_NAME_THRESHOLD,
    MAX_DCM_SCHEMA_HINT_LIMIT,
    MAX_DCM_SCHEMA_HINT_MAX_CHARS,
    MAX_DCM_TOOL_NAME_THRESHOLD,
    MIN_DCM_SCHEMA_HINT_MAX_CHARS,
    clampNumber
  } from './adminSettingsTypes'

  interface Props {
    requiredLimit: number
    optionalLimit: number
    toolNameThreshold: number
    maxChars: number
    disabled: boolean
    onRequiredLimitChange: (value: number) => void
    onOptionalLimitChange: (value: number) => void
    onToolNameThresholdChange: (value: number) => void
    onMaxCharsChange: (value: number) => void
  }

  let {
    requiredLimit,
    optionalLimit,
    toolNameThreshold,
    maxChars,
    disabled,
    onRequiredLimitChange,
    onOptionalLimitChange,
    onToolNameThresholdChange,
    onMaxCharsChange
  }: Props = $props()
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Dynamic Schema Hints"
  icon={Search}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Dynamic Schema Hints" contentClass="w-80">
      <p>
        Tune how much schema detail Batshit includes in dynamic tool hint blocks, including MCP
        search, DCM tool hints, and other dynamic schema summaries. This changes prompt size and
        clarity, not permissions.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="dcm-schema-required-limit">
            Required Fields Shown
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Required Fields Shown">
            <p>
              Default {DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT}. Higher values increase DCM size.
              Maximum is {MAX_DCM_SCHEMA_HINT_LIMIT}.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="dcm-schema-required-limit"
          type="number"
          min="1"
          max={MAX_DCM_SCHEMA_HINT_LIMIT}
          step="1"
          value={requiredLimit}
          oninput={(event) =>
            onRequiredLimitChange(
              clampNumber(
                (event.target as HTMLInputElement).value,
                1,
                MAX_DCM_SCHEMA_HINT_LIMIT
              )
            )}
          disabled={disabled}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="dcm-schema-optional-limit">
            Optional Fields Shown
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Optional Fields Shown">
            <p>
              Default {DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT}. Optional fields are the first ones
              Batshit trims away. Maximum is {MAX_DCM_SCHEMA_HINT_LIMIT}.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="dcm-schema-optional-limit"
          type="number"
          min="0"
          max={MAX_DCM_SCHEMA_HINT_LIMIT}
          step="1"
          value={optionalLimit}
          oninput={(event) =>
            onOptionalLimitChange(
              clampNumber(
                (event.target as HTMLInputElement).value,
                0,
                MAX_DCM_SCHEMA_HINT_LIMIT
              )
            )}
          disabled={disabled}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="dcm-tool-name-threshold">
            Max Tools Listed Per Group
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Max Tools Listed Per Group">
            <p>
              Default {DEFAULT_DCM_TOOL_NAME_THRESHOLD}. Inherited/default groups above this
              threshold collapse to the group name only; explicit agent display choices are
              honored. Maximum is {MAX_DCM_TOOL_NAME_THRESHOLD}.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="dcm-tool-name-threshold"
          type="number"
          min="1"
          max={MAX_DCM_TOOL_NAME_THRESHOLD}
          step="1"
          value={toolNameThreshold}
          oninput={(event) =>
            onToolNameThresholdChange(
              clampNumber(
                (event.target as HTMLInputElement).value,
                1,
                MAX_DCM_TOOL_NAME_THRESHOLD
              )
            )}
          disabled={disabled}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="dcm-schema-max-chars">
            Max Characters Per Hint
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Max Characters Per Hint">
            <p>
              Default {DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS}. Hints above this length are hidden. Range
              is {MIN_DCM_SCHEMA_HINT_MAX_CHARS}-{MAX_DCM_SCHEMA_HINT_MAX_CHARS}.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="dcm-schema-max-chars"
          type="number"
          min={MIN_DCM_SCHEMA_HINT_MAX_CHARS}
          max={MAX_DCM_SCHEMA_HINT_MAX_CHARS}
          step="10"
          value={maxChars}
          oninput={(event) =>
            onMaxCharsChange(
              clampNumber(
                (event.target as HTMLInputElement).value,
                MIN_DCM_SCHEMA_HINT_MAX_CHARS,
                MAX_DCM_SCHEMA_HINT_MAX_CHARS
              )
            )}
          disabled={disabled}
        />
      </div>
    </div>
  </div>
</SettingsAccordionCard>
