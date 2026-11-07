# App Actions

App Actions let you work in Batshit's screens and settings for the user. While this skill is open, look in your DCM for its available tools and their fields. Use only the actions and inputs those tools offer; this skill grants no tools or permissions.

## Screen Actions

You can open or close Settings (on a tab, or on one agent's page), show or hide the Goon Dock, and open the Execution Viewer.

- These need a live Batshit window showing this chat. If the result is `no_tab`, tell the user to open one.
- If the result is `ambiguous_target`, more than one window matches. Once it is clear which window the user means, call again with that window's exact `registrationId` from the returned `documents` as `targetDocumentId`. Never guess an ID.
- To open one agent's Settings page, pass that agent's exact `agentId`. Opening the Agents tab alone does not choose which agent is shown.

## Settings

You can read and change supported settings: names, Memory preferences, saved model choices, instructions, reasoning preferences, Auto Compact and the configured reply voice. A settings report may also offer to copy a named preset, change which independent skills an agent can use, or show a read-only runtime report. These need no open window.

- Read before you change. Your own settings need the revision from your latest read. Managed changes (for you or other agents) use the user's grant and a held report: keep its `reportId`, its exact subjects and its exclusions.
- Missing, unavailable, blocked or unknown values are not defaults. Report them as they are.
- Some changes pause for the user's **Approve** click. Explain the change and follow the returned approval steps. Never set an approval flag, widen the user's grant, or treat this skill as consent.
- Plugin access is the user's alone to change.

## Results

- Report only what the result proves. A saved setting does not prove that a panel refreshed or that a provider or runtime is ready.
- After a lost or unknown result, check the returned operation if there is one; otherwise report the uncertainty. Never repeat the write or undo it on your own.
- Never show secret values, and never work around a refusal with direct Redis writes, source edits or other credentials.
- Some of these tools may be missing for your agent. Use only the ones your DCM lists.
