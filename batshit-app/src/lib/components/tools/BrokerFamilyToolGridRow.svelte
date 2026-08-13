<script lang="ts">
  /**
   * Standalone top-level Tool Grid row for a broker family that has no gateway and no
   * per-item catalog: Fabric controls and published agent-usable Artifact runtime tools.
   *
   * SA-096. This row is used **only** on the discoverability-only surfaces — Subagent
   * Settings and the Chatbar dropdown — which do not render the `Batshit Tools` section.
   * On Global and Agent Settings the same two controls live on the existing
   * `Fabric Controls` / `Artifact Tools` rows inside that section, so a family never
   * appears twice in one grid.
   *
   * The controls themselves come from `BrokerFamilyDiscoverabilityCells` so both
   * placements stay identical.
   */
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import BrokerFamilyDiscoverabilityCells from '$lib/components/tools/BrokerFamilyDiscoverabilityCells.svelte'
  import type { BrokerFamilyRowControls } from './brokerFamilyRowControls'

  interface Props {
    controls: BrokerFamilyRowControls
    rowClass: string
  }

  let { controls, rowClass }: Props = $props()
</script>

{#snippet infoMenu()}
  <SettingsInfoMenu
    ariaLabel={`About ${controls.label}`}
    side="left"
    align="end"
    class="ml-auto shrink-0"
    contentClass="w-72"
  >
    {#each controls.infoParagraphs as paragraph, index (index)}
      <p class={index === 0 ? '' : 'mt-2'}>{paragraph}</p>
    {/each}
  </SettingsInfoMenu>
{/snippet}

<tr class={`${rowClass} ${controls.disabled ? 'opacity-60' : ''}`}>
  <td class="batshit-settings-table-cell is-strong">
    <div class="batshit-settings-tool-grid-label">
      <ToolGridIdentityIcon ref={controls.iconRef} typeLabel="Tool Group" name={controls.label} />
      <span class="batshit-settings-tool-grid-name block truncate" title={controls.label}>
        {controls.label}
      </span>
    </div>
  </td>
  <BrokerFamilyDiscoverabilityCells {controls} trailing={infoMenu} detailLayout="spread" />
</tr>
