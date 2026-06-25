<script lang="ts">
  import * as RadioGroup from '$lib/components/ui/radio-group'
  import * as Label from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import {
    Maximize2,
    Grid3x3,
    Layers,
    Monitor,
    Search,
    Database,
    MessageSquare
  } from '@lucide/svelte'
  
  // Props
  let {
    position = $bindable<string | undefined>(undefined),
    artifactType = '',
    onPositionChange = (pos: string | undefined) => {}
  } = $props<{
    position?: string | undefined
    artifactType?: string
    onPositionChange?: (pos: string | undefined) => void
  }>()
  
  // Widget placement options with descriptions
  const placementOptions = [
    {
      value: 'none',
      label: 'No Zone',
      description: 'Only published to Artifacts Gallery here in the Artifacts Panel.',
      icon: null,
      recommended: []
    },
    {
      value: 'header',
      label: 'Header Icon',
      description: 'Header icon that opens a popover; best for quick-launch utilities.',
      icon: Maximize2,
      recommended: ['search-tool', 'file-browser', 'api-explorer']
    },
    {
      value: 'panel',
      label: 'Artifact Panel & Icon',
      description: 'Right-side panel column (with rail icon) for medium/large tools you want open while chatting.',
      icon: Layers,
      recommended: ['dashboard', 'workspace tools', 'chat helpers']
    },
    {
      value: 'trigger',
      label: 'Trigger Dropdown',
      description: 'Header dropdown for buttons and tiny forms only; stays open until explicitly closed.',
      icon: Grid3x3,
      recommended: ['hf-space', 'mini-form', 'shortcuts']
    }
  ]
  
  // Get recommended placement based on artifact type
  function isRecommended(option: any) {
    return option.recommended.includes(artifactType)
  }
  
  // Handle change
  function handleChange(value: string) {
    const newPosition = value === 'none' ? undefined : value
    position = newPosition
    onPositionChange(newPosition)
  }
  
  // Get example icons for each zone
  function getExampleIcon(value: string) {
    switch(value) {
      case 'header': return Search
      case 'trigger': return Database
      case 'panel': return MessageSquare
      default: return Monitor
    }
  }
</script>

<div class="widget-placement-config">
  <div>
    <Label.Root class="widget-placement-heading">Artifact Placement</Label.Root>
    <p class="widget-placement-copy">
      All artifacts are published to the Artifacts Gallery; optionally publish to a zone below.
    </p>
  </div>
  
  <RadioGroup.Root 
    value={position || 'none'} 
    onValueChange={handleChange}
    class="widget-placement-options"
  >
    {#each placementOptions as option}
      {@const Icon = option.icon}
      {@const ExampleIcon = getExampleIcon(option.value)}
      {@const recommended = isRecommended(option)}
      {@const inputId = `artifact-zone-${option.value}`}
      
      <div class="widget-placement-option-shell">
        <RadioGroup.Item id={inputId} value={option.value} class="widget-placement-radio" />
        <Label.Root 
          for={inputId}
          class="widget-placement-option"
        >
          <div class="widget-placement-icon-slot">
            {#if Icon}
              <Icon class="widget-placement-icon" />
            {:else}
              <div class="widget-placement-empty-icon"></div>
            {/if}
          </div>
          
          <div class="widget-placement-option-body">
            <div class="widget-placement-option-title-row">
              <span class="widget-placement-option-title">{option.label}</span>
              {#if recommended}
                <Badge variant="secondary" class="widget-placement-badge">Recommended</Badge>
              {/if}
            </div>
            
            <p class="widget-placement-option-copy">
              {option.description}
            </p>
            
            {#if option.value !== 'none'}
              <div class="widget-placement-examples">
                <span class="widget-placement-example-label">Examples:</span>
                <div class="widget-placement-example-list">
                  <ExampleIcon class="widget-placement-example-icon" />
                  <span class="widget-placement-example-text">
                    {option.recommended.slice(0, 2).join(', ')}
                  </span>
                </div>
              </div>
            {/if}
          </div>
        </Label.Root>
      </div>
    {/each}
  </RadioGroup.Root>
  
  {#if position && position !== 'none'}
    <div class="widget-placement-note">
      <p class="widget-placement-note-copy">
        <span class="widget-placement-note-label">Note:</span> This artifact will appear as a widget in the {
          position === 'header' ? 'header bar' :
          position === 'trigger' ? 'trigger dropdown' :
          'panel'
        } when published.
      </p>
    </div>
  {/if}
</div>

<style>
  .widget-placement-config,
  :global(.widget-placement-options),
  .widget-placement-option-body {
    display: flex;
    flex-direction: column;
  }

  .widget-placement-config {
    gap: 16px;
  }

  :global(.widget-placement-heading) {
    font-size: 1rem;
    font-weight: 600;
  }

  .widget-placement-copy {
    margin-top: 4px;
    color: var(--muted-foreground);
    font-size: 0.875rem;
  }

  :global(.widget-placement-options) {
    gap: 12px;
  }

  .widget-placement-option-shell {
    position: relative;
  }

  :global(.widget-placement-radio) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  :global(.widget-placement-option) {
    display: flex;
    cursor: pointer;
    align-items: flex-start;
    gap: 12px;
    border: 2px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    transition: background-color 0.16s ease, border-color 0.16s ease;
  }

  :global(.widget-placement-option:hover) {
    background: oklch(from var(--accent) l c h / 0.5);
  }

  :global(.widget-placement-radio[data-state="checked"] + .widget-placement-option) {
    border-color: var(--primary);
    background: oklch(from var(--primary) l c h / 0.05);
  }

  .widget-placement-icon-slot {
    flex-shrink: 0;
    margin-top: 2px;
  }

  :global(.widget-placement-icon),
  .widget-placement-empty-icon {
    width: 20px;
    height: 20px;
  }

  :global(.widget-placement-icon),
  :global(.widget-placement-example-icon),
  .widget-placement-option-copy,
  .widget-placement-example-label,
  .widget-placement-example-text {
    color: var(--muted-foreground);
  }

  .widget-placement-empty-icon {
    border: 2px solid oklch(from var(--muted-foreground) l c h / 0.5);
    border-radius: 4px;
  }

  .widget-placement-option-body {
    flex: 1 1 0;
    gap: 4px;
  }

  .widget-placement-option-title-row,
  .widget-placement-examples,
  .widget-placement-example-list {
    display: flex;
    align-items: center;
  }

  .widget-placement-option-title-row,
  .widget-placement-example-list {
    gap: 8px;
  }

  .widget-placement-option-title,
  .widget-placement-note-label {
    font-weight: 500;
  }

  :global(.widget-placement-badge),
  .widget-placement-example-label,
  .widget-placement-example-text {
    font-size: 0.75rem;
  }

  .widget-placement-option-copy,
  .widget-placement-note-copy {
    font-size: 0.875rem;
  }

  .widget-placement-examples {
    gap: 4px;
    margin-top: 8px;
  }

  :global(.widget-placement-example-icon) {
    width: 12px;
    height: 12px;
  }

  .widget-placement-note {
    border-radius: 8px;
    background: oklch(from var(--muted) l c h / 0.5);
    padding: 12px;
  }
</style>
