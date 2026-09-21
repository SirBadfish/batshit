<script lang="ts">
  /**
   * SA-124 P1: KoboldCpp's sampler order, dragged rather than typed.
   *
   * SillyTavern users expect a drag list here; a text box of seven numbers is
   * the thing that would read as cheap. The stored value is still the plain
   * comma list the parameter adapter understands (`6,0,1,3,4,2,5`), so this is
   * only an editor on top of it, not a new storage shape.
   *
   * Blank means "not sent" (DL-102-01). The default order is offered as a place
   * to START, and Reset returns to blank rather than to the default, so a user
   * who never customises never sends KoboldCpp its own default back.
   *
   * Up/down buttons sit beside the drag handle on purpose: drag and drop alone
   * cannot be done from a keyboard.
   */
  import { Button } from '$lib/components/ui/button'
  import { GripVertical, ChevronUp, ChevronDown, RotateCcw } from '@lucide/svelte'
  import {
    KOBOLDCPP_SAMPLER_SLOTS,
    KOBOLDCPP_DEFAULT_SAMPLER_ORDER,
    parseSamplerOrder
  } from '$lib/utils/parameterValueAdapter'

  let {
    value = '',
    onChange
  }: {
    value?: string
    onChange: (next: string) => void
  } = $props()

  const order = $derived(parseSamplerOrder(value) ?? null)
  let draggingIndex = $state<number | null>(null)

  function commit(next: number[]) {
    onChange(next.join(','))
  }

  function move(from: number, to: number) {
    if (!order || to < 0 || to >= order.length || from === to) return
    const next = [...order]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    commit(next)
  }

  function handleDrop(target: number) {
    if (draggingIndex === null) return
    move(draggingIndex, target)
    draggingIndex = null
  }
</script>

<div class="batshit-settings-form-stack">
  {#if !order}
    <div class="flex items-center justify-between gap-3">
      <p class="batshit-settings-caption">Not sent, KoboldCpp decides</p>
      <Button
        variant="outline"
        size="sm"
        onclick={() => commit([...KOBOLDCPP_DEFAULT_SAMPLER_ORDER])}
      >
        Customise Order
      </Button>
    </div>
  {:else}
    <div class="space-y-1" role="list" aria-label="Sampler order">
      {#each order as slot, index (slot)}
        <div
          class="batshit-settings-model-row flex items-center justify-between gap-2"
          role="listitem"
          draggable="true"
          ondragstart={() => (draggingIndex = index)}
          ondragend={() => (draggingIndex = null)}
          ondragover={(event) => event.preventDefault()}
          ondrop={(event) => {
            event.preventDefault()
            handleDrop(index)
          }}
          style:opacity={draggingIndex === index ? 0.5 : null}
        >
          <div class="flex min-w-0 items-center gap-2">
            <GripVertical class="h-4 w-4 shrink-0 cursor-grab" aria-hidden="true" />
            <span class="batshit-settings-form-label w-4 shrink-0 text-right">{index + 1}</span>
            <span class="batshit-settings-form-label truncate">{KOBOLDCPP_SAMPLER_SLOTS[slot]}</span>
          </div>
          <div class="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              title="Move up"
              aria-label={`Move ${KOBOLDCPP_SAMPLER_SLOTS[slot]} up`}
              disabled={index === 0}
              onclick={() => move(index, index - 1)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Move down"
              aria-label={`Move ${KOBOLDCPP_SAMPLER_SLOTS[slot]} down`}
              disabled={index === order.length - 1}
              onclick={() => move(index, index + 1)}
            >
              <ChevronDown />
            </Button>
          </div>
        </div>
      {/each}
    </div>
    <div class="flex justify-end">
      <Button variant="outline" size="sm" onclick={() => onChange('')}>
        <RotateCcw />
        Reset
      </Button>
    </div>
  {/if}
</div>
