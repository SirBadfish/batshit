<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    APP_ACTIONS_PROTECTED_CATEGORIES, APP_ACTIONS_MANAGEMENT_EXCEPTIONS,
    type AppActionsPolicy, type AppActionsPermissionMode, type AppActionsSubjectChoice
  } from '$lib/appActions/settings/managementContract'
  import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'

  let { policy, subjects, portable = false, disabled = false, onChange }: {
    policy: AppActionsPolicy; subjects: AppActionsSubjectChoice[]; portable?: boolean
    disabled?: boolean; onChange: (policy: AppActionsPolicy) => void
  } = $props()

  const modeLabels = { block: 'Block', ask: 'Ask first', allow: 'Allow' }
  const protectedLabels = { instructions: 'Instructions', memorySettings: 'Memory Settings', contextManagement: 'Context Management' }
  const managementLabels = { skillAccess: 'Skill Access', mcpManagement: 'MCP Management', runtimeManagement: 'Runtime Management' }
  const scopeLabels = { self: 'This agent', selected: 'Chosen agents', all: 'All agents' }
  const choices = $derived.by(() => {
    const rows = [...subjects]
    for (const subject of [...policy.scope.subjects, ...policy.scope.except]) {
      if (!rows.some(row => settingsSubjectKey(row.subject) === settingsSubjectKey(subject))) {
        rows.push({ subject, label: subject.id, type: 'api', available: false })
      }
    }
    return rows
  })
  function patch(next: Partial<AppActionsPolicy>) {
    if (!disabled) onChange({ ...policy, ...next })
  }
  function chooseScope(value: string | string[] | undefined) {
    if (disabled || value !== 'self' && value !== 'selected' && value !== 'all' || portable && value === 'self') return
    patch({ scope: { mode: value, subjects: value === 'selected' ? policy.scope.subjects : [], except: value === 'self' ? [] : policy.scope.except } })
  }
  function toggleSubject(subject: SettingsSubjectRef, excluded: boolean) {
    if (disabled) return
    const key = excluded ? 'except' : 'subjects'
    const present = policy.scope[key].some(item => settingsSubjectKey(item) === settingsSubjectKey(subject))
    patch({ scope: { ...policy.scope, [key]: present
      ? policy.scope[key].filter(item => settingsSubjectKey(item) !== settingsSubjectKey(subject))
      : [...policy.scope[key], subject] } })
  }
  function permission(value: string | string[] | undefined): value is AppActionsPermissionMode {
    return value === 'block' || value === 'ask' || value === 'allow'
  }
</script>

<div class="batshit-settings-form-stack">
  <div class="batshit-settings-toggle-row is-spine-toggle">
    <div class="batshit-settings-form-label-line">
      <span class="batshit-settings-parent-label">Enable App Actions</span>
      <SettingsInfoMenu ariaLabel="About App Actions Access">
        Inspect supported settings for the chosen agents and choose which changes need your approval.
        Other tool permissions still apply.
      </SettingsInfoMenu>
    </div>
    <Switch.Root aria-label="Enable App Actions" checked={policy.enabled} {disabled}
      onCheckedChange={checked => patch({ enabled: checked === true })} />
  </div>
  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy"><span class="batshit-settings-child-label">Applies to</span></div>
    <div class="batshit-settings-form-control">
      <Select.Root type="single" value={policy.scope.mode} {disabled} onValueChange={chooseScope}>
        <Select.Trigger aria-label="App Actions subjects">{scopeLabels[policy.scope.mode]}</Select.Trigger>
        <Select.Content>
          {#if !portable}<Select.Item value="self">This agent</Select.Item>{/if}
          <Select.Item value="selected">Chosen agents</Select.Item>
          <Select.Item value="all">All agents</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>
  {#if policy.scope.mode !== 'self'}
    {#if choices.length === 0}<p class="batshit-settings-caption">No agents are available.</p>{/if}
    {#each choices as choice (settingsSubjectKey(choice.subject))}
      {@const included = policy.scope.subjects.some(item => settingsSubjectKey(item) === settingsSubjectKey(choice.subject))}
      {@const excluded = policy.scope.except.some(item => settingsSubjectKey(item) === settingsSubjectKey(choice.subject))}
      <div class="batshit-settings-toggle-row is-child">
        <div class="batshit-settings-form-label-line">
          <span class="batshit-settings-child-label">{choice.label}</span>
          <SettingsInfoMenu ariaLabel={`About ${choice.label} App Actions subject`}>
            {choice.subject.kind}:{choice.subject.id}{!choice.available ? ' (unavailable)' : ''}
          </SettingsInfoMenu>
        </div>
        <div class="batshit-settings-spine-control-cell">
          {#if policy.scope.mode === 'selected'}
            <div class="flex items-center gap-2"><span class="batshit-settings-caption">Include</span>
              <Switch.Root aria-label={`Include ${choice.label} (${settingsSubjectKey(choice.subject)})`}
                checked={included} disabled={disabled || !choice.available && !included}
                onCheckedChange={() => toggleSubject(choice.subject, false)} />
            </div>
          {/if}
          <div class="flex items-center gap-2"><span class="batshit-settings-caption">Exclude</span>
            <Switch.Root aria-label={`Exclude ${choice.label} (${settingsSubjectKey(choice.subject)})`}
              checked={excluded} disabled={disabled || !choice.available && !excluded}
              onCheckedChange={() => toggleSubject(choice.subject, true)} />
          </div>
        </div>
      </div>
    {/each}
    <p class="batshit-settings-form-meta">Exclusions stay outside this permission, including when all agents are chosen.</p>
  {/if}
  <div class="batshit-settings-toggle-row is-spine-toggle">
    <span class="batshit-settings-parent-label">Ordinary Settings Changes</span>
    <Switch.Root aria-label="Ordinary Settings Changes" checked={policy.ordinaryChanges} {disabled}
      onCheckedChange={checked => patch({ ordinaryChanges: checked === true })} />
  </div>
  {#each APP_ACTIONS_PROTECTED_CATEGORIES as category}
    <div class="batshit-settings-form-row is-child">
      <div class="batshit-settings-form-copy"><span class="batshit-settings-child-label">{protectedLabels[category]}</span></div>
      <div class="batshit-settings-form-control">
        <Select.Root type="single" value={policy.protected[category]} {disabled}
          onValueChange={value => { if (permission(value)) patch({ protected: { ...policy.protected, [category]: value } }) }}>
          <Select.Trigger aria-label={`${protectedLabels[category]} permission`}>{modeLabels[policy.protected[category]]}</Select.Trigger>
          <Select.Content>{#each ['block', 'ask', 'allow'] as mode}<Select.Item value={mode}>{modeLabels[mode as AppActionsPermissionMode]}</Select.Item>{/each}</Select.Content>
        </Select.Root>
      </div>
    </div>
  {/each}
  {#each APP_ACTIONS_MANAGEMENT_EXCEPTIONS as category}
    <div class="batshit-settings-form-row is-child">
      <div class="batshit-settings-form-copy"><span class="batshit-settings-child-label">{managementLabels[category]}</span></div>
      <div class="batshit-settings-form-control">
        <Select.Root type="single" value={policy.management[category]} {disabled}
          onValueChange={value => { if (permission(value)) patch({ management: { ...policy.management, [category]: value } }) }}>
          <Select.Trigger aria-label={`${managementLabels[category]} permission`}>{modeLabels[policy.management[category]]}</Select.Trigger>
          <Select.Content>{#each ['block', 'ask', 'allow'] as mode}<Select.Item value={mode}>{modeLabels[mode as AppActionsPermissionMode]}</Select.Item>{/each}</Select.Content>
        </Select.Root>
      </div>
    </div>
  {/each}
</div>
