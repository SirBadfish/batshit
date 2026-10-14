<script lang="ts">
  import { findRetiredCodexModel } from '$lib/data/codex-models'
  import { findRetiredClaudeCliModel } from '$lib/data/claude-cli-models'

  /**
   * BL-158 (Josh's option A) — the line under an agent's or a Subagent's Codex or Claude model
   * picker when the saved model is one Batshit's list no longer offers. Such a run stops before
   * the CLI starts (`cliModelAvailability.ts`), so the setting says so where it is changed. A
   * model id Batshit never listed shows nothing. The quiet mark on every dropdown is BL-328.
   */
  interface Props {
    runtime: 'codex' | 'claude'
    model: string | null | undefined
  }

  let { runtime, model }: Props = $props()

  const retired = $derived(
    runtime === 'codex' ? findRetiredCodexModel(model) : findRetiredClaudeCliModel(model)
  )
  const cliName = $derived(runtime === 'codex' ? 'Codex' : 'Claude')
</script>

{#if retired}
  <p class="batshit-settings-form-meta is-warning" data-testid="retired-cli-model-notice">
    {retired.label} left Batshit's {cliName} list on {retired.leftOn}, so runs with it stop before they
    start. Pick another model.
  </p>
{/if}
