---
name: "goon-scene-creator"
description: "Plan and generate Batshit Goon scenes with Room Builder, skybox placement, props, markers, and hardware-aware texture choices."
license: "Proprietary (Batshit system skill)"
metadata: {"system":"true","domain":"goons","command":"/batshit:goon-scene-creator","mcp_scope_mode":"replace","mcp_scope_gateways":"all","displayName":"Goon Scene Creator","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_skill","trust":"trusted","toolGroups":"sys.goon_scene.*"}
---

# Goon Scene Creator

Plan Batshit Goon scenes, Room Builder textures, skyboxes, props, and placement. Read the selected lane before generating assets or using controls.

## Choose the operating lane

- **Inside Batshit:** use the server-provided skill identity and read [the native operating guide](references/native.md) with `native_skill(action="read")` before doing this workflow. Native tool policy, actor access, and approvals still apply.
- **Outside Batshit:** read [the outside-agent operating guide](references/outside.md) first. Operational work uses only `GET /api/health`, `POST /api/controls/find`, and `POST /api/controls/use`, with `x-batshit-portable-token` on the two control routes. Never use service credentials, copied cookies, direct Redis, or core-source edits.

A plugin or skill is guidance, not a tool grant. Keep each skill's own tool requirements. Portable Skill Tokens remain scoped to the job and granted families; one token may cover several families, and package installation grants none.

## On-demand references

Start with [batshit-scene-spec.md](references/batshit-scene-spec.md) for the scene contract, [skybox-generation.md](references/skybox-generation.md) for skies, or [animated-panorama.md](references/animated-panorama.md) for motion. Keep the hardware-aware resolution and creator-respect rules in the lane guide.
