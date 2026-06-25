<script lang="ts">
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import type { AvatarIconFit, CustomIconRecord, IconRef } from '$lib/icons/iconTypes'

  let {
    ref,
    customIcons = [],
    fit = 'fill',
    label = '',
    class: className = 'h-full w-full text-muted-foreground',
    fillIconClass = 'batshit-avatar-icon-fill'
  }: {
    ref?: IconRef | null
    customIcons?: CustomIconRecord[]
    fit?: AvatarIconFit | null
    label?: string
    class?: string
    fillIconClass?: string
  } = $props()

  const iconClass = $derived.by(() => {
    // Kept as accepted no-op props so older avatar records/callers cannot shrink icon avatars.
    void fit
    return fillIconClass
  })
  const imageClass = $derived.by(() => ['block object-contain', fillIconClass].filter(Boolean).join(' '))
</script>

<IconRenderer
  {ref}
  {customIcons}
  {label}
  class={className}
  {iconClass}
  {imageClass}
  forceDarkModeInvert
/>
