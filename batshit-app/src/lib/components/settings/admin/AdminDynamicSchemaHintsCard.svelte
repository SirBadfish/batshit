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
    DEFAULT_DCM_TOTAL_HINT_TOKENS,
    MAX_DCM_SCHEMA_HINT_LIMIT,
    MAX_DCM_SCHEMA_HINT_MAX_CHARS,
    MAX_DCM_TOOL_NAME_THRESHOLD,
    MAX_DCM_TOTAL_HINT_TOKENS,
    MIN_DCM_SCHEMA_HINT_MAX_CHARS,
    MIN_DCM_TOTAL_HINT_TOKENS,
    clampNumber,
    normalizeTotalHintTokens
  } from './adminSettingsTypes'

  interface Props {
    requiredLimit: number
    optionalLimit: number
    toolNameThreshold: number
    maxChars: number
    totalTokens: number
    disabled: boolean
    onRequiredLimitChange: (value: number) => void
    onOptionalLimitChange: (value: number) => void
    onToolNameThresholdChange: (value: number) => void
    onMaxCharsChange: (value: number) => void
    onTotalTokensChange: (value: number) => void
  }

  let {
    requiredLimit,
    optionalLimit,
    toolNameThreshold,
    maxChars,
    totalTokens,
    disabled,
    onRequiredLimitChange,
    onOptionalLimitChange,
    onToolNameThresholdChange,
    onMaxCharsChange,
    onTotalTokensChange
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
        Tune scalable tool hints in Agent Setup, Tool Search results, and other dynamic schema
        summaries. Fixed built-in feature hints keep their complete guidance. These controls
        change hint size and detail without changing permissions.
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
              Default {DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT} for scalable tool hints. Higher
              values increase hint size.
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
              Default {DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT} for scalable tool hints. Optional
              fields are the first ones Batshit trims away. Maximum is {MAX_DCM_SCHEMA_HINT_LIMIT}.
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
              threshold collapse to the group name and count. Explicit agent display choices can
              show more tools, within the total tool hint budget. Maximum is {MAX_DCM_TOOL_NAME_THRESHOLD}.
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
              Default {DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS}. Scalable tool hints above this length
              are hidden. Fixed built-in feature hints keep their complete guidance. Range is
              {MIN_DCM_SCHEMA_HINT_MAX_CHARS}-{MAX_DCM_SCHEMA_HINT_MAX_CHARS}.
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

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="dcm-schema-total-tokens">
            Total Tool Hint Budget
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Total Tool Hint Budget">
            <p>
              Default {DEFAULT_DCM_TOTAL_HINT_TOKENS} estimated tokens. Range is
              {MIN_DCM_TOTAL_HINT_TOKENS}-{MAX_DCM_TOTAL_HINT_TOKENS}. Estimates use characters
              divided by four, rounded up. Batshit collapses the largest tool groups to their
              names and counts until they fit. Fixed feature hints and the complete enabled skills
              catalog are separate from this budget, so total Agent Setup can be larger.
            </p>
            <p>
              If group names and counts alone exceed the budget, Batshit shows an error. Increase
              the budget, enable fewer groups, or shorten group names before continuing.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="dcm-schema-total-tokens"
          type="number"
          min={MIN_DCM_TOTAL_HINT_TOKENS}
          max={MAX_DCM_TOTAL_HINT_TOKENS}
          step="100"
          value={totalTokens}
          oninput={(event) =>
            onTotalTokensChange(normalizeTotalHintTokens((event.target as HTMLInputElement).value))}
          disabled={disabled}
        />
      </div>
    </div>
  </div>
</SettingsAccordionCard>
