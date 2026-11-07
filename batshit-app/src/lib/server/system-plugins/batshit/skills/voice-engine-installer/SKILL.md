---
name: "voice-engine-installer"
description: "Install, verify, and register Batshit TTS/STT speech engines through the server-owned Engine Manager."
license: "Proprietary (Batshit system skill)"
compatibility: "batshit-prelaunch"
metadata: {"system":"true","domain":"voice","command":"/batshit:voice-engine-installer","displayName":"TTS/STT Engine Installer","allowedTools":"native_batshit_tool_search,native_batshit_tool_use,native_bash_execute,native_skill","trust":"trusted","toolGroups":"sys.voice.engine.*,sys.runtime_addon.*"}
---

# TTS/STT Engine Installer

Install, verify, register, and troubleshoot Batshit TTS/STT engines. Read the selected lane before preflight, installation, registration, or enablement; then load its mandatory and path-specific engine references.

## Choose the operating lane

- **Inside Batshit:** use the server-provided skill identity and read [the native operating guide](references/native.md) with `native_skill(action="read")` before doing this workflow. Native tool policy, actor access, and approvals still apply.
- **Outside Batshit:** read [the outside-agent operating guide](references/outside.md) first. Operational work uses only `GET /api/health`, `POST /api/controls/find`, and `POST /api/controls/use`, with `x-batshit-portable-token` on the two control routes. Never use service credentials, copied cookies, direct Redis, or core-source edits.

A plugin or skill is guidance, not a tool grant. Keep each skill's own tool requirements. Portable Skill Tokens remain scoped to the job and granted families; one token may cover several families, and package installation grants none.

## On-demand references

Begin with [runtime-preflight.md](references/runtime-preflight.md). Preserve engine-local installs, credential consent, runtime health and smoke proof, completion rules, and the two-strikes stop rule in the operating guide.
