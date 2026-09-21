<script lang="ts">
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'

  /**
   * SA-120 (DL-120-01/13) — the per-agent Jev Juice switches, one spine toggle per feature.
   * Every one defaults OFF. The wording is the LS-049/LS-050 convention:
   * `Jev Juice: <what it does>`, and each (i) says exactly what text leaves the machine
   * when it is on.
   *
   * - P1 **Suggest Skills and Tools** (LS-049): Batshit asks Jev before each reply.
   * - P2 **Judgment Tool** (LS-050): the agent gets `sys.judge.ask` and asks Jev itself.
   * - P4a **Rerank Memory Search** (LS-052): Jev judges each hit of the agent's memory
   *   search.
   * - P4b **Recall by Meaning** (LS-053): before each reply Jev judges which
   *   long-term memories bear on the message, and Batshit brings those in.
   * Both memory switches ride Agent Memory: with memory off there is no search tool and no
   * recall lane, so the toggles are shown but cannot be changed.
   * - P6 **Check Replies** (LS-055): after each reply Batshit compares what it says with what
   *   the turn really did (facts first, Jev for the wording).
   * - P6 **Style Coach** (LS-056): after each reply Batshit counts repeated wording and asks
   *   Jev about habits. Neither ever edits a reply.
   */
  interface Props {
    skillToolHintsEnabled: boolean
    judgeToolEnabled: boolean
    memoryRerankEnabled: boolean
    memoryRecallEnabled: boolean
    replyCheckEnabled: boolean
    styleCoachEnabled: boolean
    /** The agent's Agent Memory switch, as the form holds it right now. */
    memoryEnabled: boolean
    disabled?: boolean
    onSkillToolHintsEnabledChange: (enabled: boolean) => void
    onJudgeToolEnabledChange: (enabled: boolean) => void
    onMemoryRerankEnabledChange: (enabled: boolean) => void
    onMemoryRecallEnabledChange: (enabled: boolean) => void
    onReplyCheckEnabledChange: (enabled: boolean) => void
    onStyleCoachEnabledChange: (enabled: boolean) => void
  }

  let {
    skillToolHintsEnabled,
    judgeToolEnabled,
    memoryRerankEnabled,
    memoryRecallEnabled,
    replyCheckEnabled,
    styleCoachEnabled,
    memoryEnabled,
    disabled = false,
    onSkillToolHintsEnabledChange,
    onJudgeToolEnabledChange,
    onMemoryRerankEnabledChange,
    onMemoryRecallEnabledChange,
    onReplyCheckEnabledChange,
    onStyleCoachEnabledChange
  }: Props = $props()
</script>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.skill_tool_hints.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About Jev Juice skill and tool hints" contentClass="w-80">
      <p>
        Before each reply, Batshit asks TypeSafe's Jev model which of this agent's skills or tools the
        message most likely needs, and whether it needs something that is turned off for this agent.
        The agent gets a one-line hint it may ignore; you get a small note on the reply when a
        capability is missing.
      </p>
      <p>
        When this is on, the text of your message, this agent's skill names, its tool names, and the
        names of capabilities it does not have leave this computer and go to TypeSafe's servers.
        Nothing else is sent. Off by default; needs Jev Juice turned on in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={skillToolHintsEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onSkillToolHintsEnabledChange(checked === true)}
    data-testid="agent-jev-skill-tool-hints-toggle"
  />
</div>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.judge_ask.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About the Jev Juice judgment tool" contentClass="w-80">
      <p>
        Gives this agent a tool that hands a piece of text or data plus typed questions to TypeSafe's
        Jev model and gets probabilities back: is this true, which of these, where on this scale. The
        agent decides what to do with the numbers. Jev never writes text, never approves anything,
        and never acts on its own.
      </p>
      <p>
        When this is on, whatever the agent puts in a call leaves this computer and goes to TypeSafe's
        servers. That can include parts of your messages, files, or search results the agent chooses
        to send. Every call shows in the Execution Viewer. Off by default; needs Jev Juice turned on
        in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={judgeToolEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onJudgeToolEnabledChange(checked === true)}
    data-testid="agent-jev-judge-tool-toggle"
  />
</div>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.memory_rerank.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About the Jev Juice memory search rerank" contentClass="w-80">
      <p>
        When this agent searches its memories, Batshit looks at a longer list of matches than the
        agent asked for and asks TypeSafe's Jev model how well each one answers the search. That
        judgment joins the usual ranking (match, freshness, importance), so a memory that truly
        answers the search can reach the top even when it is old. If Jev does not answer, the agent
        gets the usual ranking and is told so.
      </p>
      <p>
        When this is on, the agent's search words and the text of up to 25 matching memories leave
        this computer and go to TypeSafe's servers, each time the agent searches. Needs Agent Memory
        on for this agent. Off by default; needs Jev Juice turned on in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={memoryRerankEnabled}
    disabled={disabled || !memoryEnabled}
    onCheckedChange={(checked) => onMemoryRerankEnabledChange(checked === true)}
    data-testid="agent-jev-memory-rerank-toggle"
  />
</div>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.memory_recall.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About Jev Juice recall by meaning" contentClass="w-80">
      <p>
        Today a long-term memory reaches this agent only when the agent stops to search for it, and
        trigger memories need their exact trigger words. With this on, before each reply Batshit
        finds the long-term memories closest to your message and asks TypeSafe's Jev model which
        ones would change the answer. Up to three are placed in the agent's context, marked as
        inferred, and they linger like any recalled memory. The agent is told Batshit brought them
        in. If Jev does not answer in time, the message is sent without them and a small note says so.
      </p>
      <p>
        When this is on, the text of each message you send and the text of up to 20 of this agent's
        long-term memories leave this computer and go to TypeSafe's servers, on every message. Needs
        Agent Memory on for this agent. Off by default; needs Jev Juice turned on in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={memoryRecallEnabled}
    disabled={disabled || !memoryEnabled}
    onCheckedChange={(checked) => onMemoryRecallEnabledChange(checked === true)}
    data-testid="agent-jev-memory-recall-toggle"
  />
</div>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.reply_check.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About the Jev Juice reply check" contentClass="w-80">
      <p>
        After each reply from this agent, Batshit compares what the reply says with what the turn
        really did. It already knows which tools ran, whether one failed, and whether a memory was
        saved. It asks TypeSafe's Jev model only about the wording: does the reply say it did
        something no tool call matches, does it promise to remember when nothing was saved, does it
        stay quiet about a failed step, did it miss part of your message. You get a small chip under
        the reply, and the agent is told once, on its next turn. The reply itself is never changed.
      </p>
      <p>
        When this is on, your message, the agent's finished reply, and the one-line labels of the
        tools it used in this chat (tool names, file paths, commands, search words, web addresses,
        never their content) leave this computer and go to TypeSafe's servers, after every reply.
        Off by default; needs Jev Juice turned on in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={replyCheckEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onReplyCheckEnabledChange(checked === true)}
    data-testid="agent-jev-reply-check-toggle"
  />
</div>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">{TYPESAFE_FEATURES.style_coach.switchLabel}</span>
    <SettingsInfoMenu ariaLabel="About the Jev Juice style coach" contentClass="w-80">
      <p>
        After each reply from this agent, Batshit counts repeated openings, closings, and stock
        phrases across its recent replies, on this computer. It then asks TypeSafe's Jev model two
        things counting cannot see: whether the agent keeps opening by praising you, and whether its
        replies lean on the same habit. You get a small chip under the reply, and the agent is told
        once, on its next turn, so it can vary its wording. The reply itself is never changed.
      </p>
      <p>
        When this is on, the agent's finished reply and its three replies before it (shortened)
        leave this computer and go to TypeSafe's servers, after every reply. Off by default; needs
        Jev Juice turned on in Settings → Admin.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={styleCoachEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onStyleCoachEnabledChange(checked === true)}
    data-testid="agent-jev-style-coach-toggle"
  />
</div>
