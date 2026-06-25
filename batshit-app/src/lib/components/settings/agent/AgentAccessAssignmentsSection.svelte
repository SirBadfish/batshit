<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import type { SubagentRow, SlashCommandRow } from '$lib/types/database'
  import type { ArtifactRow } from '$lib/services/artifactService'

  type SaveState = 'idle' | 'saving' | 'saved'
  type AgentAccessSaveScope = 'agent-skills' | 'agent-artifacts'

  interface Props {
    sectionClass: string
    subagentsLoading: boolean
    subagents: SubagentRow[]
    selectedSubagentIds: string[]
    selectedAgentId: string | null
    primaryAgentLabel: string
    compatibleSubagentTypesLabel: string
    assignmentSaveState: SaveState
    assignmentSaveError: string | null
    accessSaveState: SaveState
    accessSaveError: string | null
    accessSaveScope: string
    accessResourcesLoading: boolean
    accessResourcesLoaded: boolean
    accessResourcesError: string | null
    accessSlashCommands: SlashCommandRow[]
    accessArtifacts: ArtifactRow[]
    isSubagentCompatible: (subagent: SubagentRow) => boolean
    formatSubagentBadge: (subagent: SubagentRow) => string
    getSlashCommandEnabledForEntity: (command: SlashCommandRow, entityId: string | null) => boolean
    getArtifactEnabledForEntity: (artifact: ArtifactRow, entityId: string | null) => boolean
    getArtifactAccessScope: (artifact: ArtifactRow) => 'all' | 'selected'
    getArtifactPlacementLabel: (artifact: ArtifactRow) => string
    onSubagentToggle: (id: string, checked: boolean) => void
    onSlashCommandToggle: (
      command: SlashCommandRow,
      entityId: string,
      enabled: boolean,
      scope: AgentAccessSaveScope
    ) => void | Promise<void>
    onArtifactToggle: (
      artifact: ArtifactRow,
      entityId: string,
      enabled: boolean,
      scope: AgentAccessSaveScope
    ) => void | Promise<void>
    onAccessSaveScopeChange: (scope: AgentAccessSaveScope) => void
  }

  let {
    sectionClass,
    subagentsLoading,
    subagents,
    selectedSubagentIds,
    selectedAgentId,
    primaryAgentLabel,
    compatibleSubagentTypesLabel,
    assignmentSaveState,
    assignmentSaveError,
    accessSaveState,
    accessSaveError,
    accessSaveScope,
    accessResourcesLoading,
    accessResourcesLoaded,
    accessResourcesError,
    accessSlashCommands,
    accessArtifacts,
    isSubagentCompatible,
    formatSubagentBadge,
    getSlashCommandEnabledForEntity,
    getArtifactEnabledForEntity,
    getArtifactAccessScope,
    getArtifactPlacementLabel,
    onSubagentToggle,
    onSlashCommandToggle,
    onArtifactToggle,
    onAccessSaveScopeChange
  }: Props = $props()

  const sortedSubagents = $derived.by(() => {
    return [...subagents].sort((a, b) => {
      const aCompat = isSubagentCompatible(a) ? 0 : 1
      const bCompat = isSubagentCompatible(b) ? 0 : 1
      if (aCompat !== bCompat) return aCompat - bCompat
      return a.displayName.localeCompare(b.displayName)
    })
  })
</script>

<SettingsAccordionCard
  name="agent-access-cards"
  title="Assigned Subagents"
  batshitIcon="subagents"
  class={sectionClass}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Assigned Subagents">
      Pick which Subagents this Primary Agent can call.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    <SettingsSaveStatus
      state={assignmentSaveError ? 'error' : assignmentSaveState}
      error={assignmentSaveError}
      savingLabel="Saving subagent assignments..."
      savedLabel="Saved"
    />
  {/snippet}
  {#if subagentsLoading}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      Loading subagents…
    </div>
  {:else if subagents.length === 0}
    <p class="batshit-settings-caption">
      You have no Subagents yet. Create Subagents from the list on the left, then assign them here.
    </p>
  {:else}
    <div class="space-y-3">
      <div class="batshit-settings-form-stack">
        {#each sortedSubagents as subagent (subagent.id)}
          {@const compatible = isSubagentCompatible(subagent)}
          <div
            class={`batshit-settings-toggle-row is-spine-with-badges ${compatible ? '' : 'is-disabled'}`}
          >
            <div class="batshit-settings-form-label-line">
              <span class={`batshit-settings-parent-label truncate ${compatible ? '' : 'is-disabled'}`}>
                {subagent.displayName}
              </span>
            </div>
            <div class="batshit-settings-spine-control-cell">
              <Switch.Root
                checked={selectedSubagentIds.includes(subagent.id)}
                disabled={!compatible}
                onCheckedChange={(checked) => {
                  if (!compatible) return
                  onSubagentToggle(subagent.id, checked === true)
                }}
              />
              <Badge variant="outline" class="batshit-settings-spine-badge">
                {formatSubagentBadge(subagent)}
              </Badge>
            </div>
          </div>
        {/each}
      </div>

      <div class="batshit-settings-form-label-line">
        <span class="batshit-settings-form-label">Compatibility Rules</span>
        <SettingsInfoMenu ariaLabel="About Subagent Compatibility Rules">
          {primaryAgentLabel} Primary Agents can only call {` ${compatibleSubagentTypesLabel}.`}
          Incompatible Subagents stay visible for awareness but their toggles are disabled.
        </SettingsInfoMenu>
      </div>
    </div>
  {/if}
</SettingsAccordionCard>

<SettingsAccordionCard
  name="agent-access-cards"
  title="Skills & Prompts"
  batshitIcon="skills"
  class={sectionClass}
  contentClass="space-y-3"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Agent Skills And Prompts">
      Manage which reusable skills and prompts this agent can use. Global “All agents” stays in
      Skills &amp; Prompts settings. Individual access lives here.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    {#if accessSaveScope === 'agent-skills'}
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
              checked={getSlashCommandEnabledForEntity(command, selectedAgentId)}
              disabled={command.enabled_for_all_agents === true || !selectedAgentId}
              onCheckedChange={(checked) => {
                if (!selectedAgentId) return
                void onSlashCommandToggle(
                  command,
                  selectedAgentId,
                  checked === true,
                  'agent-skills'
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
  name="agent-access-cards"
  title="Artifacts"
  batshitIcon="artifacts"
  class={sectionClass}
  contentClass="space-y-3"
  onfocusin={() => onAccessSaveScopeChange('agent-artifacts')}
  onpointerdown={() => onAccessSaveScopeChange('agent-artifacts')}
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Agent Artifacts">
      Manage which artifacts this agent can discover and use. Global Agent Use and “All agents” stay
      in Artifact settings. Individual access lives here.
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    {#if accessSaveScope === 'agent-artifacts'}
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
              checked={getArtifactEnabledForEntity(artifact, selectedAgentId)}
              disabled={artifact.agent_use_enabled === false || artifactScope === 'all' || !selectedAgentId}
              onCheckedChange={(checked) => {
                if (!selectedAgentId) return
                void onArtifactToggle(
                  artifact,
                  selectedAgentId,
                  checked === true,
                  'agent-artifacts'
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
