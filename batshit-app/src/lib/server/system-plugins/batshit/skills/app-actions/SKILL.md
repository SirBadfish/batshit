---
name: "app-actions"
description: "Open Settings, show or hide the Goon, open the Execution Viewer, or read and change supported agent settings for the user."
license: "Proprietary (Batshit system skill)"
compatibility: "Batshit with App Actions; outside operation requires a scoped Portable Skill Token."
metadata: {"system":"true","domain":"app-actions","command":"/batshit:app-actions","displayName":"App Actions","allowedTools":"native_batshit_tool_search,native_batshit_tool_use","toolGroups":"sys.ui.*,sys.app_settings.*","trust":"trusted"}
---

# App Actions

Use App Actions for Batshit views and supported Settings work. Read the matching operating guide before acting:

- **Inside Batshit:** read [the native guide](references/native.md) with your current skill-document tool and this skill's server-provided `skillId`.
- **Outside Batshit:** read [the outside guide](references/outside.md). Use only the two scoped Settings controls it describes; screen controls require an in-app actor and an open chat window.

A skill is guidance, not a permission grant. Keep the user's current scope, approvals and each operating lane's limits.
