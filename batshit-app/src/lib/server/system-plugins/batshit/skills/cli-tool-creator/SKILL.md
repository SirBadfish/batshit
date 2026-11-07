---
name: "cli-tool-creator"
description: "Create, update, test, and review Batshit CLI tools through a light Fabric-driven workflow."
license: "Proprietary (Batshit system skill)"
compatibility: "batshit-prelaunch"
metadata: {"system":"true","domain":"tools","command":"/batshit:cli-tool-creator","displayName":"CLI Tool Creator","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_bash_execute,native_skill","trust":"trusted","toolGroups":"sys.cli_tool.*,sys.runtime_addon.*"}
---

# CLI Tool Creator

Create, update, test, and review saved Batshit CLI tools. Understand the executable, runtime location, input contract, and risks before saving; validate through the saved-record test.

## Choose the operating lane

- **Inside Batshit:** use the server-provided skill identity and read [the native operating guide](references/native.md) with `native_skill(action="read")` before doing this workflow. Native tool policy, actor access, and approvals still apply.
- **Outside Batshit:** read [the outside-agent operating guide](references/outside.md) first. Operational work uses only `GET /api/health`, `POST /api/controls/find`, and `POST /api/controls/use`, with `x-batshit-portable-token` on the two control routes. Never use service credentials, copied cookies, direct Redis, or core-source edits.

A plugin or skill is guidance, not a tool grant. Keep each skill's own tool requirements. Portable Skill Tokens remain scoped to the job and granted families; one token may cover several families, and package installation grants none.

## On-demand references

The lane references retain the argument-template and schema guides, saved-key rules, companion-skill decision, exact controls, and failure handling.
