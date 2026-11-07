---
name: "skill-creator"
description: "Create, update, and refine Batshit skills and prompts that work well with any AI model."
license: "Proprietary (Batshit system skill)"
compatibility: "batshit-prelaunch"
metadata: {"system":"true","domain":"skills","command":"/batshit:skill-creator","displayName":"Skill Creator","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_skill","trust":"trusted","toolGroups":"sys.skill.*"}
---

# Skill Creator

Create, update, refine, or import Batshit Skills and reusable Prompt commands. Read the selected lane before saving or importing; it owns the Skill-versus-Prompt decision, access preservation, runtime dependencies, and exact controls.

The current panel is **Settings → Plugins & shit**. Independent custom Skills/Prompts keep individual access; plugin members use the human-owned plugin switch in **Agents → Access** or global **Plugins → Enable for All Agents**. When preserved references name an individual built-in skill switch, use that plugin route. Never rewrite a plugin member, grant package access, or broaden a one-skill App Actions approval.

## Choose the operating lane

- **Inside Batshit:** use the server-provided skill identity and read [the native operating guide](references/native.md) with `native_skill(action="read")` before doing this workflow. Native tool policy, actor access, and approvals still apply.
- **Outside Batshit:** read [the outside-agent operating guide](references/outside.md) first. Operational work uses only `GET /api/health`, `POST /api/controls/find`, and `POST /api/controls/use`, with `x-batshit-portable-token` on the two control routes. Never use service credentials, copied cookies, direct Redis, or core-source edits.

A plugin or skill is guidance, not a tool grant. Keep each skill's own tool requirements. Portable Skill Tokens remain scoped to the job and granted families; one token may cover several families, and package installation grants none.

## On-demand references

Read [writing-for-llms.md](references/writing-for-llms.md) when authoring instructions. Built-in system skills are protected; a saved skill cannot grant itself access or tools.
