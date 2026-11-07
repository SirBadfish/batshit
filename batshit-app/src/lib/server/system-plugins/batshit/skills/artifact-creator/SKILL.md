---
name: "artifact-creator"
description: "Build, configure, and publish persistent mini-app artifacts in Batshit."
license: "Proprietary (Batshit system skill)"
compatibility: "batshit-prelaunch"
metadata: {"system":"true","domain":"artifacts","command":"/batshit:artifact-creator","mcp_scope_mode":"replace","mcp_scope_gateways":"all","displayName":"Artifact Creator","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_skill","trust":"trusted","toolGroups":"sys.artifact.*,artifact.*,sys.model_catalog.*,sys.pinokio.*,sys.comfyui.*,sys.runtime_addon.*"}
---

# Artifact Creator

Build, configure, validate, update, publish, or roll back a persistent Batshit Artifact. Read the selected lane before any operation, then load only the power-source or runtime references it calls for.

## Choose the operating lane

- **Inside Batshit:** use the server-provided skill identity and read [the native operating guide](references/native.md) with `native_skill(action="read")` before doing this workflow. Native tool policy, actor access, and approvals still apply.
- **Outside Batshit:** read [the outside-agent operating guide](references/outside.md) first. Operational work uses only `GET /api/health`, `POST /api/controls/find`, and `POST /api/controls/use`, with `x-batshit-portable-token` on the two control routes. Never use service credentials, copied cookies, direct Redis, or core-source edits.

A plugin or skill is guidance, not a tool grant. Keep each skill's own tool requirements. Portable Skill Tokens remain scoped to the job and granted families; one token may cover several families, and package installation grants none.

## On-demand references

For Builder Kit, start with [builder-kit-api.md](references/builder-kit-api.md); for existing Artifacts, [editing.md](references/editing.md); for tools and publication, [fabric-and-agent-use.md](references/fabric-and-agent-use.md).
