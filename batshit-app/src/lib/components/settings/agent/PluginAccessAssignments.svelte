<script lang="ts">
  import { onMount } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import { AgentPluginSaveError, changeAgentPlugin, loadAgentPlugins } from '$lib/services/agentPluginClient'
  import { dispatchSlashCommandsUpdated, LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
  import type { AgentPluginDescriptor } from '$lib/types/agentPlugins'

  let { entityId, sectionClass = '' }: { entityId: string | null; sectionClass?: string } = $props()
  let plugins = $state<AgentPluginDescriptor[]>([])
  let loading = $state(true)
  let loaded = $state(false)
  let saving = $state(false)
  let saved = $state(false)
  let error = $state<string | null>(null)
  let uncertain = $state(false)
  let alive = false
  let generation = 0
  let trailingRead = false

  async function refresh() {
    const read = ++generation
    if (saving) { trailingRead = true; return }
    loading = true
    try {
      const rows = await loadAgentPlugins()
      if (!alive || read !== generation) return
      plugins = rows
      loaded = true
      error = null
      uncertain = false
    } catch (failure) {
      if (alive && read === generation) error = failure instanceof Error ? failure.message : 'Plugins could not be loaded.'
    } finally {
      if (alive && read === generation) loading = false
    }
  }

  async function toggle(plugin: AgentPluginDescriptor, enabled: boolean) {
    const target = entityId
    if (!target || saving || loading || !loaded || uncertain || plugin.enabled_for_all_agents || plugin.installing || plugin.removing) return
    saving = true
    saved = false
    error = null
    ++generation
    try {
      const result = await changeAgentPlugin(`/api/plugins/${encodeURIComponent(plugin.id)}/agent-access`, { agentId: target, enabled })
      if (!alive || !result) return
      plugins = plugins.map(row => row.id === result.id ? result : row)
      saved = true
      dispatchSlashCommandsUpdated({ source: 'agent-access' })
    } catch (failure) {
      if (!alive) return
      error = failure instanceof Error ? failure.message : 'Plugin access could not be saved.'
      uncertain = !(failure instanceof AgentPluginSaveError) || failure.outcomeUnknown
    } finally {
      saving = false
      if (alive && trailingRead && !uncertain) { trailingRead = false; void refresh() }
    }
  }

  onMount(() => {
    alive = true
    void refresh()
    const changed = () => { if (!uncertain) void refresh() }
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, changed)
    return () => {
      alive = false
      ++generation
      window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, changed)
    }
  })
</script>

<SettingsAccordionCard name="plugin-access" title="Plugins" batshitIcon="skills" class={sectionClass} contentClass="space-y-3" open>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Plugin Access">
      One switch makes all of a plugin's skills available to this agent. Tools and Portable Skill Tokens keep their own permissions.
      Turn off Enable for All Agents in Plugins &amp; shit → Plugins to choose individual agents here.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    <SettingsSaveStatus state={error ? 'error' : saving ? 'saving' : saved ? 'saved' : 'idle'} {error} savingLabel="Saving access..." savedLabel="Saved" />
  {/snippet}
  {#if error}
    <div class="batshit-settings-inline-alert is-danger">
      <span>{error}</span>
      <Button variant="outline" size="sm" disabled={loading || saving} onclick={() => void refresh()}>Refresh Saved Plugins</Button>
    </div>
  {/if}
  {#if loading && !loaded}
    <div class="batshit-settings-inline-alert is-dashed">Loading plugins…</div>
  {:else if loaded && plugins.length === 0}
    <div class="batshit-settings-inline-alert is-dashed">No plugins installed.</div>
  {:else if loaded}
    <div class="batshit-settings-form-stack">
      {#each plugins as plugin (plugin.id)}
        <div class="batshit-settings-toggle-row is-spine-with-badges">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-parent-label truncate">{plugin.name}</span>
            <SettingsInfoMenu ariaLabel={`About ${plugin.name} Plugin`}>
              {plugin.description}
              <span class="mt-1 block">{plugin.skills.map(skill => skill.name).join(', ')}</span>
            </SettingsInfoMenu>
          </div>
          <div class="batshit-settings-spine-control-cell">
            <Switch.Root
              aria-label={`${plugin.name} plugin access`}
              checked={plugin.enabled_for_all_agents || Boolean(entityId && plugin.enabled_agent_ids.includes(entityId))}
              disabled={!entityId || plugin.enabled_for_all_agents || plugin.installing || plugin.removing || saving || loading || Boolean(error) || uncertain}
              onCheckedChange={checked => void toggle(plugin, checked === true)}
            />
            <Badge variant="outline" class="batshit-settings-spine-badge">{plugin.removing ? 'Removing' : plugin.installing ? 'Incomplete' : `${plugin.skills.length} ${plugin.skills.length === 1 ? 'Skill' : 'Skills'}`}</Badge>
            {#if plugin.enabled_for_all_agents}<Badge variant="secondary" class="batshit-settings-spine-badge">All Agents</Badge>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</SettingsAccordionCard>
