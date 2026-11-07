<script lang="ts">
  import { settingsSubjectKey } from '$lib/appActions/settings/reportContract'
  import { APP_ACTIONS_PROTECTED_CATEGORIES, APP_ACTIONS_MANAGEMENT_EXCEPTIONS, type AppActionsPolicy } from '$lib/appActions/settings/managementContract'
  let { policy }: { policy: AppActionsPolicy } = $props()
  const modes = { block: 'Block', ask: 'Ask first', allow: 'Allow' }
  const labels = { instructions: 'Instructions', memorySettings: 'Memory Settings', contextManagement: 'Context Management', skillAccess: 'Skill Access', mcpManagement: 'MCP Management', runtimeManagement: 'Runtime Management' }
</script>
<dl class="batshit-settings-form-stack">
  <div><dt class="batshit-settings-child-label">App Actions</dt><dd class="batshit-settings-caption">{policy.enabled ? 'Enabled' : 'Disabled'}</dd></div>
  <div><dt class="batshit-settings-child-label">Applies to</dt><dd class="batshit-settings-caption">{({ self: 'This agent', all: 'All agents', selected: 'Chosen agents' })[policy.scope.mode]}</dd></div>
  {#if policy.scope.subjects.length}<div><dt class="batshit-settings-child-label">Chosen Agents</dt><dd class="batshit-settings-code-caption">{policy.scope.subjects.map(settingsSubjectKey).join(', ')}</dd></div>{/if}
  {#if policy.scope.except.length}<div><dt class="batshit-settings-child-label">Excluded Agents</dt><dd class="batshit-settings-code-caption">{policy.scope.except.map(settingsSubjectKey).join(', ')}</dd></div>{/if}
  <div><dt class="batshit-settings-child-label">Ordinary Settings Changes</dt><dd class="batshit-settings-caption">{policy.ordinaryChanges ? 'Allowed' : 'Blocked'}</dd></div>
  {#each APP_ACTIONS_PROTECTED_CATEGORIES as category}<div><dt class="batshit-settings-child-label">{labels[category]}</dt><dd class="batshit-settings-caption">{modes[policy.protected[category]]}</dd></div>{/each}
  {#each APP_ACTIONS_MANAGEMENT_EXCEPTIONS as category}<div><dt class="batshit-settings-child-label">{labels[category]}</dt><dd class="batshit-settings-caption">{modes[policy.management[category]]}</dd></div>{/each}
</dl>
