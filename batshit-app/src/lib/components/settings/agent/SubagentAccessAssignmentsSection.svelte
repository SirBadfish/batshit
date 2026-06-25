<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import type { SlashCommandRow } from '$lib/types/database'
  import type { ArtifactRow } from '$lib/services/artifactService'

  type SaveState = 'idle' | 'saving' | 'saved'
  type SubagentAccessSaveScope = 'subagent-skills' | 'subagent-artifacts'

  interface Props {
    sectionClass: string
    selectedSubagentId: string | null
    accessSaveState: SaveState
    accessSaveError: string | null
    accessSaveScope: string
    accessResourcesLoading: boolean
    accessResourcesLoaded: boolean
    accessResourcesError: string | null
    accessSlashCommands: SlashCommandRow[]
    accessArtifacts: ArtifactRow[]
    getSlashCommandEnabledForEntity: (command: SlashCommandRow, entityId: string | null) => boolean
    getArtifactEnabledForEntity: (artifact: ArtifactRow, entityId: string | null) => boolean
    getArtifactAccessScope: (artifact: ArtifactRow) => 'all' | 'selected'
    getArtifactPlacementLabel: (artifact: ArtifactRow) => string
    onSlashCommandToggle: (
      command: SlashCommandRow,
      entityId: string,
      enabled: boolean,
      scope: SubagentAccessSaveScope
    ) => void | Promise<void>
    onArtifactToggle: (
      artifact: ArtifactRow,
      entityId: string,
      enabled: boolean,
      scope: SubagentAccessSaveScope
    ) => void | Promise<void>
    onAccessSaveScopeChange: (scope: SubagentAccessSaveScope) => void
  }

  let {
    sectionClass,
    selectedSubagentId,
    accessSaveState,
    accessSaveError,
    accessSaveScope,
    accessResourcesLoading,
    accessResourcesLoaded,
    accessResourcesError,
    accessSlashCommands,
    accessArtifacts,
    getSlashCommandEnabledForEntity,
    getArtifactEnabledForEntity,
    getArtifactAccessScope,
    getArtifactPlacementLabel,
    onSlashCommandToggle,
    onArtifactToggle,
    onAccessSaveScopeChange
  }: Props = $props()
</script>

<SettingsAccordionCard
  name="subagent-access-cards"
  title="Skills & Prompts"
  batshitIcon="skills"
  class={sectionClass}
  contentClass="space-y-3"
  onfocusin={() => onAccessSaveScopeChange('subagent-skills')}
  onpointerdown={() => onAccessSaveScopeChange('subagent-skills')}
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Subagent Skills And Prompts">
      Manage which reusable skills and prompts this subagent is assigned to. These assignments also
      feed the subagent's compiled Skills &amp; Prompts guidance, so it knows which Batshit commands
      it can invoke while running. Global “All agents” stays in Skills &amp; Prompts settings.
      Individual access lives here.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    {#if accessSaveScope === 'subagent-skills'}
      <SettingsSaveStatus
        state={accessSaveError ? 'error' : accessSaveState}
        error={accessSaveError}
        savingLabel="Saving access..."
        savedLabel="Saved"
      />
    {/if}
  {/snippet}
  {#if accessResourcesLoading && !accessResourcesLoaded}
    <div class="batshit-settings-inline-alert is-dashed">Loading skills and prompts…</div>
  {:else if accessResourcesError}
    <div class="batshit-settings-inline-alert is-danger">{accessResourcesError}</div>
  {:else if accessSlashCommands.length === 0}
    <div class="batshit-settings-inline-alert is-dashed">No skills or prompts found yet.</div>
  {:else}
    <div class="batshit-settings-form-stack">
      {#each accessSlashCommands as command (command.id)}
        <div class="batshit-settings-toggle-row is-spine-with-badges">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-parent-label truncate">
              {command.displayName || command.name || command.id}
            </span>
            <SettingsInfoMenu ariaLabel={`About ${command.displayName || command.name || command.id}`}>
              <span class="batshit-settings-code-caption">
                {(command.invocation_pattern || `/${command.id}`).trim()}
              </span>
              {#if command.description}
                <span class="mt-1 block">{command.description}</span>
              {/if}
            </SettingsInfoMenu>
          </div>
          <div class="batshit-settings-spine-control-cell">
            <Switch.Root
              checked={getSlashCommandEnabledForEntity(command, selectedSubagentId)}
              disabled={command.enabled_for_all_agents === true || !selectedSubagentId}
              onCheckedChange={(checked) => {
                if (!selectedSubagentId) return
                void onSlashCommandToggle(
                  command,
                  selectedSubagentId,
                  checked === true,
                  'subagent-skills'
                )
              }}
            />
            <Badge variant="outline" class="batshit-settings-spine-badge">
              {command.type === 'skill' ? 'Skill' : 'Prompt'}
            </Badge>
            {#if command.enabled_for_all_agents === true}
              <Badge variant="secondary" class="batshit-settings-spine-badge">All Agents</Badge>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</SettingsAccordionCard>

<SettingsAccordionCard
  name="subagent-access-cards"
  title="Artifacts"
  batshitIcon="artifacts"
  class={sectionClass}
  contentClass="space-y-3"
  onfocusin={() => onAccessSaveScopeChange('subagent-artifacts')}
  onpointerdown={() => onAccessSaveScopeChange('subagent-artifacts')}
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Subagent Artifacts">
      Manage which artifacts this subagent can access. Global Agent Use and “All agents” stay in
      Artifact settings. Individual access lives here.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    {#if accessSaveScope === 'subagent-artifacts'}
      <SettingsSaveStatus
        state={accessSaveError ? 'error' : accessSaveState}
        error={accessSaveError}
        savingLabel="Saving access..."
        savedLabel="Saved"
      />
    {/if}
  {/snippet}
  {#if accessResourcesLoading && !accessResourcesLoaded}
    <div class="batshit-settings-inline-alert is-dashed">Loading artifacts…</div>
  {:else if accessResourcesError}
    <div class="batshit-settings-inline-alert is-danger">{accessResourcesError}</div>
  {:else if accessArtifacts.length === 0}
    <div class="batshit-settings-inline-alert is-dashed">No agent-usable artifacts found yet.</div>
  {:else}
    <div class="batshit-settings-form-stack">
      {#each accessArtifacts as artifact (artifact.id)}
        {@const artifactScope = getArtifactAccessScope(artifact)}
        <div class="batshit-settings-toggle-row is-spine-with-badges">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-parent-label truncate">{artifact.name || artifact.id}</span>
            <SettingsInfoMenu ariaLabel={`About ${artifact.name || artifact.id}`}>
              <span class="batshit-settings-code-caption">{artifact.id}</span>
              <span class="mt-1 block">{artifact.slug}</span>
              {#if artifact.agent_use_enabled === false}
                <span class="mt-1 block">Enable Agent Use in Artifact settings first.</span>
              {:else if artifactScope === 'all'}
                <span class="mt-1 block">Controlled globally from Artifact settings.</span>
              {/if}
            </SettingsInfoMenu>
          </div>
          <div class="batshit-settings-spine-control-cell">
            <Switch.Root
              checked={getArtifactEnabledForEntity(artifact, selectedSubagentId)}
              disabled={artifact.agent_use_enabled === false || artifactScope === 'all' || !selectedSubagentId}
              onCheckedChange={(checked) => {
                if (!selectedSubagentId) return
                void onArtifactToggle(
                  artifact,
                  selectedSubagentId,
                  checked === true,
                  'subagent-artifacts'
                )
              }}
            />
            <Badge variant="outline" class="batshit-settings-spine-badge">
              {getArtifactPlacementLabel(artifact)}
            </Badge>
            {#if artifact.agent_use_enabled === false}
              <Badge variant="destructive" class="batshit-settings-spine-badge">Global Off</Badge>
            {:else if artifactScope === 'all'}
              <Badge variant="secondary" class="batshit-settings-spine-badge">All Agents</Badge>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</SettingsAccordionCard>
