<script lang="ts" module>
  export type GoonMotionPickerOption = {
    name: string
    label: string
    sourceLabel?: string | null
    posture?: string
    postureLabel?: string
    tags?: string[]
  }
</script>

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { cn } from '$lib/utils'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'

  type NormalizedMotionOption = Required<Omit<GoonMotionPickerOption, 'sourceLabel'>> & {
    sourceLabel: string | null
  }

  type MotionGroup = {
    id: string
    label: string
    motions: NormalizedMotionOption[]
  }

  let {
    options = [],
    value = '',
    placeholder = 'Select motion (optional)',
    noneLabel = 'None',
    disabled = false,
    ariaLabel = 'Select motion',
    class: className,
    onChange = () => {}
  }: {
    options?: GoonMotionPickerOption[]
    value?: string
    placeholder?: string
    noneLabel?: string
    disabled?: boolean
    ariaLabel?: string
    class?: string
    onChange?: (value: string) => void
  } = $props()

  const anyPostureGroupId = '__any_posture__'
  const normalizedOptions = $derived.by<NormalizedMotionOption[]>(() =>
    options
      .map((option) => ({
        name: option.name,
        label: option.label || option.name,
        sourceLabel: option.sourceLabel ?? null,
        posture: option.posture ?? '',
        postureLabel: option.postureLabel ?? 'Any Posture',
        tags: Array.isArray(option.tags) ? option.tags : []
      }))
      .filter((option) => option.name)
      .sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name))
  )

  const selectedOption = $derived.by(() =>
    normalizedOptions.find((option) => option.name === value) ?? null
  )

  const postureGroups = $derived.by<MotionGroup[]>(() => {
    const groups = new Map<string, MotionGroup>()
    for (const motion of normalizedOptions) {
      const id = motion.posture || anyPostureGroupId
      const label = motion.posture ? motion.postureLabel : 'Any Posture'
      const existing = groups.get(id) ?? { id, label, motions: [] }
      existing.motions.push(motion)
      groups.set(id, existing)
    }

    return Array.from(groups.values()).sort((left, right) => {
      if (left.id === anyPostureGroupId) return -1
      if (right.id === anyPostureGroupId) return 1
      return left.label.localeCompare(right.label)
    })
  })

  const tagGroups = $derived.by<MotionGroup[]>(() => {
    const groups = new Map<string, MotionGroup>()
    for (const motion of normalizedOptions) {
      for (const tag of motion.tags) {
        const existing = groups.get(tag) ?? { id: tag, label: tag, motions: [] }
        existing.motions.push(motion)
        groups.set(tag, existing)
      }
    }
    return Array.from(groups.values()).sort((left, right) => left.label.localeCompare(right.label))
  })

  const untaggedOptions = $derived.by(() =>
    normalizedOptions.filter((motion) => motion.tags.length === 0)
  )

  const tagGroupCount = $derived.by(() =>
    tagGroups.length + (untaggedOptions.length > 0 ? 1 : 0)
  )

  function selectMotion(nextValue: string) {
    onChange(nextValue)
  }
</script>

{#snippet motionItem(motion: NormalizedMotionOption, showPosture = false)}
  <DropdownMenu.Item
    class={`goon-motion-picker-item ${motion.name === value ? 'is-selected' : ''}`}
    onSelect={() => selectMotion(motion.name)}
  >
    <span class="goon-motion-picker-option-copy">
      <span class="goon-motion-picker-option-label">{motion.label}</span>
      {#if motion.label !== motion.name}
        <span class="goon-motion-picker-option-id">{motion.name}</span>
      {/if}
    </span>
    {#if showPosture}
      <span class="goon-motion-picker-count is-offset">{motion.postureLabel}</span>
    {:else if motion.sourceLabel}
      <span class="goon-motion-picker-count is-offset">{motion.sourceLabel}</span>
    {/if}
    {#if motion.name === value}
      <Check class="goon-motion-picker-check" />
    {/if}
  </DropdownMenu.Item>
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn('goon-motion-picker-trigger bs-select-trigger', className)}
    disabled={disabled}
    aria-label={ariaLabel}
    title={selectedOption?.name ?? placeholder}
    data-slot="select-trigger"
    data-placeholder={selectedOption ? undefined : ''}
  >
    <span class="goon-motion-picker-trigger-copy">
      <span class="goon-motion-picker-trigger-label">
        {selectedOption?.label ?? placeholder}
      </span>
      {#if selectedOption?.sourceLabel}
        <span class="goon-motion-picker-trigger-meta">{selectedOption.sourceLabel}</span>
      {/if}
    </span>
    <ChevronDown class="goon-motion-picker-chevron" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="start" class="goon-motion-picker-content">
    <DropdownMenu.Item
      class={`goon-motion-picker-item ${!value ? 'is-selected' : ''}`}
      onSelect={() => selectMotion('')}
    >
      <span class="goon-motion-picker-option-copy">
        <span class="goon-motion-picker-option-label">{noneLabel}</span>
      </span>
      {#if !value}
        <Check class="goon-motion-picker-check" />
      {/if}
    </DropdownMenu.Item>

    {#if normalizedOptions.length > 0}
      <DropdownMenu.Separator />

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
          <span>All Motions</span>
          <span class="goon-motion-picker-count">{normalizedOptions.length}</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="goon-motion-picker-submenu is-motion">
          {#each normalizedOptions as motion (motion.name)}
            {@render motionItem(motion, true)}
          {/each}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
          <span>By Posture</span>
          <span class="goon-motion-picker-count">{postureGroups.length}</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="goon-motion-picker-submenu is-visible-overflow">
          {#each postureGroups as group (group.id)}
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
                <span class="goon-motion-picker-menu-label">{group.label}</span>
                <span class="goon-motion-picker-count">{group.motions.length}</span>
              </DropdownMenu.SubTrigger>
              <DropdownMenu.SubContent class="goon-motion-picker-submenu is-motion">
                {#each group.motions as motion (motion.name)}
                  {@render motionItem(motion)}
                {/each}
              </DropdownMenu.SubContent>
            </DropdownMenu.Sub>
          {/each}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
          <span>By Tag</span>
          <span class="goon-motion-picker-count">{tagGroupCount}</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="goon-motion-picker-submenu is-visible-overflow">
          {#if tagGroups.length > 0 || untaggedOptions.length > 0}
            {#each tagGroups as group (group.id)}
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
                  <span class="goon-motion-picker-menu-label">{group.label}</span>
                  <span class="goon-motion-picker-count">{group.motions.length}</span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent class="goon-motion-picker-submenu is-motion">
                  {#each group.motions as motion (motion.name)}
                    {@render motionItem(motion)}
                  {/each}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            {/each}

            {#if tagGroups.length > 0 && untaggedOptions.length > 0}
              <DropdownMenu.Separator />
            {/if}

            {#if untaggedOptions.length > 0}
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger class="goon-motion-picker-subtrigger is-wide-gap">
                  <span>Untagged</span>
                  <span class="goon-motion-picker-count">{untaggedOptions.length}</span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent class="goon-motion-picker-submenu is-motion">
                  {#each untaggedOptions as motion (motion.name)}
                    {@render motionItem(motion)}
                  {/each}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            {/if}
          {:else}
            <DropdownMenu.Item disabled>
              <span class="goon-motion-picker-muted">No tags yet</span>
            </DropdownMenu.Item>
          {/if}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {:else}
      <DropdownMenu.Item disabled>
        <span class="goon-motion-picker-muted">No motions available</span>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.goon-motion-picker-trigger) {
    width: 100%;
  }

  .goon-motion-picker-trigger-copy,
  .goon-motion-picker-option-copy {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.08rem;
  }

  .goon-motion-picker-trigger-label,
  .goon-motion-picker-option-label,
  .goon-motion-picker-menu-label {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goon-motion-picker-trigger-meta,
  .goon-motion-picker-option-id {
    max-width: 100%;
    overflow: hidden;
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.goon-motion-picker-chevron) {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: var(--bs-app-muted-text);
  }

  :global(.goon-motion-picker-content) {
    min-width: min(19rem, calc(100vw - 2rem));
    overflow: visible;
  }

  :global(.goon-motion-picker-submenu) {
    min-width: min(18rem, calc(100vw - 2rem));
  }

  :global(.goon-motion-picker-submenu.is-motion) {
    min-width: min(22rem, calc(100vw - 2rem));
    max-height: min(23rem, calc(100vh - 6rem));
    overflow-y: auto;
  }

  :global(.goon-motion-picker-submenu.is-visible-overflow) {
    overflow: visible;
  }

  :global(.goon-motion-picker-subtrigger) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  :global(.goon-motion-picker-subtrigger.is-wide-gap) {
    gap: 0.75rem;
  }

  :global(.goon-motion-picker-item) {
    min-width: 0;
  }

  :global(.goon-motion-picker-item.is-selected) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  .goon-motion-picker-count,
  .goon-motion-picker-muted {
    flex-shrink: 0;
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
  }

  .goon-motion-picker-count.is-offset {
    margin-left: 0.5rem;
  }

  :global(.goon-motion-picker-check) {
    width: 0.85rem;
    height: 0.85rem;
    flex-shrink: 0;
    color: var(--bs-app-title);
  }
</style>
