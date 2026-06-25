<script lang="ts">
  import { Plus } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import AgentMegaDropdown, {
    type MegaAgentSection
  } from '$lib/components/settings/AgentMegaDropdown.svelte'

  interface Props {
    sections: MegaAgentSection[]
    selectedId: string | null
    disabled?: boolean
    onSelectAgent: (agentId: string) => void
    onSelectSubagent: (subagentId: string) => void
    onCreateAgent: () => void
    onOpen?: () => void | Promise<void>
  }

  let {
    sections,
    selectedId,
    disabled = false,
    onSelectAgent,
    onSelectSubagent,
    onCreateAgent,
    onOpen = undefined
  }: Props = $props()

  function handleSelect(key: string) {
    if (key.startsWith('agent:')) {
      onSelectAgent(key.slice('agent:'.length))
      return
    }
    if (key.startsWith('subagent:')) {
      onSelectSubagent(key.slice('subagent:'.length))
    }
  }
</script>

<div class="space-y-4">
  <p class="batshit-settings-section-title">Agent Selector</p>

  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
    <AgentMegaDropdown
      label="Agents & Subagents"
      {sections}
      selectedId={selectedId}
      placeholder="Select a Primary Agent or Subagent"
      emptyState="No Agents or Subagents yet"
      {disabled}
      disableUnavailableItems={false}
      onSelect={handleSelect}
      {onOpen}
    />

    <Button
      class="lg:self-start"
      {disabled}
      onclick={onCreateAgent}
    >
      <Plus aria-hidden="true" />
      Create New Agent
    </Button>
  </div>
</div>
