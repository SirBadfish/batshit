# App Actions

App Actions lets an authorized Primary Agent help with supported Batshit settings. You can also give an outside assistant a scoped Portable Skill Token. Reading the Batshit Guide needs no token; performing an operation needs its own access.

## Give an agent access

Open **Settings → Agents**, choose the Primary Agent, then **Access → App Actions**. Access starts off. Choose This agent, Chosen agents or All agents, and any exclusions.

Ordinary Settings Changes is separate from Instructions, Memory Settings and Context Management. Each protected category starts at **Ask first** and can be **Block**, **Ask first** or **Allow**. Skill Access, MCP Management and Runtime Management have separate choices. Permission covers only supported actions; other tool restrictions still apply. An agent cannot grant itself these permissions.

Choose **Save App Actions Access**. Editing the card does not save it. If another change reaches storage first, review the newer saved policy and choose whether to keep your draft before saving again.

## Give an outside assistant access

Open **Settings → Plugins & shit → Portable Skills**. Create or select a Portable Skill Token, then open **App Actions Access**. Select agents and exclusions, permissions and expiry. A new grant lasts 24 hours by default and can last at most 30 days.

Choose **Save Portable App Actions Access** explicitly. Selecting the token family alone does not approve a protected change. **Remove App Actions Access** removes this scope without removing the token's other families. The outside assistant acts as the token holder, rather than becoming one of your agents.

After a restore starts replacing Batshit data, App Actions access must be granted again deliberately. A later restore failure or rollback does not restore that grant. The token's other families keep their existing behavior.

## Review one change

Ask for a specific action and the agents it should affect. A report identifies the chosen agents and exclusions, current values and available changes. Unavailable targets remain visible in the result.

With **Ask first**, an in-app agent shows an approval card with the agents, before/after values, exclusions, effects and expiry. If the complete preview cannot be confirmed, Approve stays unavailable and Deny remains available.

An outside assistant returns a review link. Sign in to the same Batshit instance, open it, and check the token label, agents, before/after values and expiry. Opening the link approves nothing. **Approve** or **Deny** answers that exact operation; it does not give continuing Allow permission.

A captured operation normally has ten minutes for review, bounded by the grant's expiry and any request deadline. Use the time shown in the review. An expired, cancelled or changed request needs a new valid review.

## What you can ask it to do

Supported targets are current Primary Agents and Subagents, at each action's stated scope. Groups, Workers and removed agent types are not Settings targets.

- **Names and Memory preferences:** change supported display names, Primary Agent Memory budgets and linger defaults. An agent can disable Memory, enable it when its configured embedder is ready, or choose automatic window modes. Disabling keeps stored memories. It does not download or prepare an embedder, tune advanced summary settings or change custom window numbers.
- **Reasoning display and retention:** change a Primary Agent's Display Reasoning and Display Whiteboard. These change what you see. Reasoning Retention and Whiteboard Budget affect future context and follow **Context Management**. They do not edit the Whiteboard text or model parameters. See [Whiteboard and reasoning retention](../chat/memory-and-infinite-sessions.md#whiteboard-and-reasoning-retention).
- **Saved models:** select an existing compatible preset or explicitly clear a selection. Unavailable choices show a reason. A supported speech-to-speech preset can configure a Primary Agent's next connection; it does not connect a room or check the account. A Subagent with no own model can inherit its parent's model; an unusable retained selection needs your attention.
- **One named preset copy:** copy an existing preset, change offered model parameters in the copy, and assign it to the selected compatible agents or Subagents. Review the original, new name, parameter changes and full target list. The original remains unchanged. If only some assignments finish, the named copy and confirmed assignments remain saved.
- **Custom instructions:** replace Custom Instructions or change Include Global Prompt for permitted agents and Subagents. Instructions follows its protected policy. Review the full old and new text; Batshit refuses a request it cannot show completely. It does not change core prompts or your global prompt text. Reading full saved custom instructions is a separate explicit request for one permitted agent. A reply already running keeps the instructions it started with.
- **Common Auto Compact preferences:** choose Off, Ask first, Automatic or inheritance, and Smart or a fixed remaining-token threshold for Primary Agents. These follow **Context Management** and affect later decisions. They do not run Compact or Nap, edit global defaults or automate advanced summary settings.
- **Configured reply voice:** select built-in/configured voices, saved choices, a saved voice profile or Use Global Default. A profile selects its provider, model and voice together. Fish account choices are available on explicit request and may be incomplete or unavailable. Selection does not test speech, prepare an engine or verify account entitlement. Other provider account catalogs are not included.
- **Existing skill and plugin access:** manage access to already-saved, invocable skills or plugins. This does not import content, edit instructions or change trust. A plugin's skills share the package's access. Converting access from everyone to named agents requires review of the complete effect, including future agents and Workers; narrower access cannot silently make that global change.
- **Runtime status:** inspect bounded observations for this Batshit instance. Unknown stays unknown. A reported file, process, version or URL does not prove readiness. Inspection does not install, start, stop, repair or change runtime settings.

Selecting or copying a model and choosing a voice are configuration changes. They do not send a model request, synthesize speech or start a voice session.

## Connect an MCP source during a task

An authorized Primary Agent in an ordinary single-agent chat can connect custom HTTP(S) MCP sources and already-installed custom local STDIO sources through the offered MCP-management controls. It uses existing saved credential references; keep secrets out of chat. Installing a local server is separate.

Review the source, agent access and any explicitly requested named-tool Zip settings. MCP-management permission covers setup; an explicit Zip change also needs Context Management, even when its requested value is already set. The agent must discover a tool's actual name before changing its Zip rule.

A saved source, a verified connection/tool list, saved agent access, saved Zip choices and a visible screen update are separate results. Setup approval does not approve what a tool later does. After setup, the agent discovers the available tools again and uses the actual returned reference under normal tool permissions.

This setup workflow is unavailable to outside token holders, Groups, Subagents and Workers. It does not provision Docker Toolkit servers, install or control Docker Desktop, or administer n8n. An already-running Docker or n8n MCP endpoint can use the same supported custom HTTP source workflow.

## Read the outcome before trying again

A result distinguishes **saved**, **checked** and **shown on screen**. An operation can contain applied, unchanged, unavailable, conflicting or blocked targets. A known save stays saved even if a later target or readback fails.

If a response is lost or an effect is unknown, use **Check Operation Outcome**. Do not repeat the same change automatically. Reading current settings cannot prove what happened to an earlier uncertain command. A confirmed save with an unavailable readback remains a confirmed save.

Clean open Settings panels follow saved changes. Unsaved drafts remain yours. If a newer saved value conflicts, use the matching **Use Saved…** action to read it and replace only that draft, then make a deliberate choice. Batshit does not merge or resend your old draft.

## Related

- [Fabric and approvals](overview.md)
- [Plugin and outside-agent setup](../skills/portable-skills.md)
- [Primary Agents](../primary-agents/overview.md)
- [Tools and MCP gateways](../tools/overview.md)
