<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { AgentPluginSaveError, changeAgentPlugin, loadAgentPlugins } from '$lib/services/agentPluginClient'
  import { dispatchSlashCommandsUpdated, LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
  import type { AgentPluginDescriptor } from '$lib/types/agentPlugins'

  let plugins = $state<AgentPluginDescriptor[]>([])
  let loading = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let uncertain = $state(false)
  let error = $state<string | null>(null)
  let warnings = $state<string[]>([])
  let selectedFile = $state<File | null>(null)
  let alive = false
  let generation = 0
  let trailingRead = false

  async function refresh() {
    const read = ++generation
    if (busy) { trailingRead = true; return }
    loading = true
    try {
      const rows = await loadAgentPlugins()
      if (!alive || generation !== read) return
      plugins = rows
      loaded = true
      error = null
      uncertain = false
    } catch (failure) {
      if (alive && generation === read) error = failure instanceof Error ? failure.message : 'Plugins could not be loaded.'
    } finally { if (alive && generation === read) loading = false }
  }

  async function mutate(path: string, body?: unknown, method = 'PUT') {
    if (!loaded || busy || loading || uncertain || error) return
    busy = true
    error = null
    ++generation
    try {
      await changeAgentPlugin(path, body, method, notes => { warnings = notes })
      if (!alive) return
      dispatchSlashCommandsUpdated({ source: 'settings' })
      trailingRead = true
    } catch (failure) {
      if (!alive) return
      error = failure instanceof Error ? failure.message : 'The plugin change could not be confirmed.'
      uncertain = !(failure instanceof AgentPluginSaveError) || failure.outcomeUnknown
    } finally {
      busy = false
      if (alive && trailingRead && !uncertain) { trailingRead = false; void refresh() }
    }
  }

  async function remove(plugin: AgentPluginDescriptor) {
    if (plugin.builtIn || busy || loading || uncertain || error) return
    const confirmed = await confirmDialog({
      title: `Remove ${plugin.name}?`,
      description: 'Remove this plugin and its imported skills from Batshit. Its original source folder stays on disk.',
      confirmLabel: 'Remove Plugin', tone: 'destructive'
    })
    if (confirmed && alive) await mutate(`/api/plugins/${encodeURIComponent(plugin.id)}`, { expectedRevision: plugin.revision }, 'DELETE')
  }

  onMount(() => {
    alive = true
    void refresh()
    const changed = () => { if (!uncertain) void refresh() }
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, changed)
    return () => { alive = false; ++generation; window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, changed) }
  })
</script>

<div class="space-y-4">
  <div class="batshit-settings-action-row">
    <h3 class="batshit-settings-section-title">Plugins</h3>
    <Button variant="outline" size="sm" disabled={loading || busy} onclick={() => void refresh()}>Refresh Saved Plugins</Button>
  </div>
  {#if error}<div class="batshit-settings-inline-alert is-danger">{error}</div>{/if}
  {#if warnings.length}<div class="batshit-settings-inline-alert is-dashed">{#each warnings as warning}<p>{warning}</p>{/each}</div>{/if}
  {#if loading && !loaded}
    <div class="batshit-settings-inline-alert is-dashed">Loading plugins…</div>
  {:else if loaded}
    {#each plugins as plugin (plugin.id)}
      <SettingsAccordionCard name="installed-plugins" title={plugin.name} batshitIcon="skills" open contentClass="space-y-3">
        {#snippet info()}
          <SettingsInfoMenu ariaLabel={`About ${plugin.name}`}>
            {plugin.description} Version {plugin.version}.
            {plugin.builtIn ? 'This built-in plugin is maintained with Batshit.' : 'Imported skills are untrusted instructions. Review them before enabling this plugin.'}
            Enabling skills does not change tool permissions or grant a Portable Skill Token.
          </SettingsInfoMenu>
        {/snippet}
        {#if plugin.removing}<p class="batshit-settings-form-help is-warning">Removal Incomplete. Finish removing this plugin to clear its remaining imported files.</p>
        {:else if plugin.installing}<p class="batshit-settings-form-help is-warning">Import Incomplete. This plugin is off. Remove it before trying a fresh import.</p>{/if}
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-toggle-row is-spine-toggle">
            <span class="batshit-settings-parent-label">Enable for All Agents</span>
            <Switch.Root aria-label={`Enable ${plugin.name} for all agents`} checked={plugin.enabled_for_all_agents}
              disabled={busy || loading || uncertain || Boolean(error) || plugin.installing || plugin.removing}
              onCheckedChange={checked => void mutate(`/api/plugins/${encodeURIComponent(plugin.id)}`, { enabled_for_all_agents: checked === true })} />
          </div>
          {#each plugin.skills as skill (skill.skillId)}
            <div class="batshit-settings-form-row">
              <span class="batshit-settings-child-label">{skill.name}</span>
              <span class="batshit-settings-code-caption">{skill.invocation}</span>
            </div>
          {/each}
        </div>
        <div class="batshit-settings-action-row">
          {#if plugin.builtIn}
            <Button variant="outline" size="sm" href={`/api/plugins/${encodeURIComponent(plugin.id)}/download`}>Download Plugin</Button>
          {:else}
            <Button variant="destructive" size="sm" disabled={busy || loading || uncertain || Boolean(error)} onclick={() => void remove(plugin)}>{plugin.removing ? 'Finish Removing' : 'Remove Plugin'}</Button>
          {/if}
        </div>
      </SettingsAccordionCard>
    {/each}
    <SettingsAccordionCard name="plugin-import" title="Import a Plugin" batshitIcon="skills" contentClass="space-y-3">
      {#snippet info()}
        <SettingsInfoMenu ariaLabel="About Plugin Import">
          Choose a complete Agent Plugins ZIP containing plugin.json and skills. Select the ZIP file on this computer. Batshit checks the complete package before importing its skills.
          Only skills are supported. References and assets must be inside their skill folders. Plugins requiring shared root assets, MCP servers, hooks or other executable extensions are refused. Import runs no installer.
        </SettingsInfoMenu>
      {/snippet}
      <div class="batshit-settings-form-row">
        <label class="batshit-settings-form-label" for="plugin-source-path">Plugin ZIP</label>
        <div class="batshit-settings-form-control is-wide"><Input id="plugin-source-path" type="file" accept=".zip,application/zip" onchange={event => { selectedFile = event.currentTarget.files?.[0] ?? null }} disabled={busy} /></div>
      </div>
      {#if selectedFile && selectedFile.size > 32 * 1024 * 1024}<p class="batshit-settings-form-help is-error">Choose a plugin ZIP no larger than 32 MB.</p>{/if}
      <div class="batshit-settings-action-row">
        <Button size="sm" disabled={!selectedFile || selectedFile.size > 32 * 1024 * 1024 || busy || loading || uncertain || Boolean(error)} onclick={() => { if (selectedFile) void mutate('/api/plugins/import', selectedFile, 'POST') }}>Import Plugin</Button>
      </div>
    </SettingsAccordionCard>
  {/if}
</div>
