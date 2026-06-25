<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import type { IconRef } from '$lib/icons/iconTypes'
  import { cn } from '$lib/utils'

  let {
    ref,
    typeLabel,
    name,
    class: className = '',
    iconClass = 'h-3.5 w-3.5'
  }: {
    ref: IconRef
    typeLabel: string
    name: string
    class?: string
    iconClass?: string
  } = $props()

  const disclosureLabel = $derived(`${typeLabel}: ${name}`)
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn('batshit-settings-tool-grid-identity-trigger', className)}
    aria-label={disclosureLabel}
    title={disclosureLabel}
  >
    <IconRenderer
      {ref}
      label={disclosureLabel}
      class="batshit-settings-tool-grid-identity-icon"
      {iconClass}
    />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    align="start"
    side="right"
    class="batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-72"
  >
    <div class="space-y-1">
      <div class="batshit-settings-form-label">{typeLabel}</div>
      <div class="batshit-settings-tool-grid-identity-copy">{name}</div>
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
