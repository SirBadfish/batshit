<script lang="ts">
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { DEFAULT_ICON_REF } from '$lib/icons/iconCatalog'
  import type { IconRef } from '$lib/icons/iconTypes'

  let selectedIcon = $state<IconRef | null>(DEFAULT_ICON_REF)
</script>

<div class="flex min-h-0 max-w-5xl flex-col gap-4">
  <div class="flex items-center gap-2">
    <BatshitIcon id="icons" class="h-5 w-5 text-muted-foreground" />
    <h3 class="batshit-settings-section-title">Icons</h3>
    <SettingsInfoMenu ariaLabel="About Icons" contentClass="w-80">
      <p>Manage saved icons, online downloads, color overrides, favorites, and recents.</p>
    </SettingsInfoMenu>
  </div>

  <IconPicker
    bind:value={selectedIcon}
    mode="inline"
    title=""
    description=""
  />
</div>
