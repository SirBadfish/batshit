# Editing an Existing Artifact

**Load when:** the user asks you to change an artifact that already exists: a targeted fix, a rewrite, a version restore, or picking a multi-session build back up. New builds do not need it.

## Read it first

Find it with `sys.artifact.list` (compact summaries), then `sys.artifact.get` with `artifactId` for the current HTML. `get` includes `content` and the version list by default; old version bodies only with `includeVersionContents: true`, which is rarely needed. A `get` that includes `content` also shows the `version` a whole-page write must name (see Rewrite).

## Targeted change: `sys.artifact.apply_patch`

Prefer a patch to resending the whole page. The `patch` input is **one string** in Batshit's apply_patch format:

```javascript
native_batshit_tool_use({
  ref: "fabric:sys.artifact.apply_patch",
  input: {
    artifactId: "...",
    versionDescription: "Tighten the output card",
    patch: `*** Begin Patch
*** Update File: artifact.html
@@
-  <div class="card">
+  <div class="card compact">
*** End Patch`
  }
})
```

- It starts with `*** Begin Patch`, has exactly one `*** Update File: artifact.html`, and ends with `*** End Patch`.
- Context lines are copied from the source as they are, indentation included; removed lines start with `-`, added lines with `+`.
- No `--- a/file` / `+++ b/file` headers, and never a JSON object or array as `patch`.
- **`context did not match`:** `get` the artifact again and rebuild the patch from the current source. After two failed patches, switch to `sys.artifact.update` with the whole `content` and the `expectedVersion` from that `get`, and only if you can keep the rest of the document exactly as it is.

## Rewrite: `sys.artifact.update`

Send `artifactId` and only the fields that change: `content` (the whole page), `metadata`, `mode`, `zone`, `icon_ref`, `model_config`, `system_prompt`, `blueprint`, `versionDescription`. Each content change becomes a new version.

`content` replaces the whole page, so it also needs `expectedVersion`: the `version` from your last result that loaded the whole page or wrote your own whole content (a `get` with content, `create`, a `content` update, or `add_version`). Never take it from an apply_patch, publish, zone, webhook, metadata, field, or rollback result: those show the stored version of a page you may not have read in full (a patch applies to the stored text, so a user's save elsewhere can sit in it), so `get` the artifact again before your next full-content write (`update` or `add_version`). Without it the update is refused before anything is read or saved. If the user (or another agent) saved a newer version after that, the update is refused with `ARTIFACT_VERSION_CONFLICT` and nothing is saved: `get` the artifact again, redo your edit on that content, and send `expectedVersion` with the `version` that `get` shows. Never resend your earlier `content` unchanged; it would take back their save. A patch applies to the text stored now: if the lines it names still match, it lands on top of a newer edit made elsewhere; if they changed, it is refused (`context did not match`) and nothing is saved. An update without `content` needs no version.

Do not send `agent_use_enabled`, `agent_access_scope`, or `agent_allowlist` when updating an existing artifact. Only the user can change access in Settings → Artifacts or Settings → Agents → Access. An update containing any of those fields is refused in full with `ARTIFACT_ACCESS_USER_ONLY`; its content edits are not saved either. Explain the required setting to the user, then send any independent content edit without access fields.

`metadata` merges key by key into the stored metadata: send only the keys you change, but a key you send replaces that whole key (a new `fabric_fields` must list every field).

## Trust the write summary

Writes answer with a compact summary, not the page. An `update` also returns `artifactUpdate.updatedFields`, `contentChanged`, and a short diff of the HTML. Call `sys.artifact.get` again only when you need the current HTML for another edit, or when the summary does not show the change you made (a field missing from `updatedFields`, or `contentChanged: false` after a content edit). After your own `create`, `content` update, or `add_version`, the summary's `artifact.version` is the `expectedVersion` for your next full-content write, so no `get` is needed to learn it. An apply_patch, publish, zone, webhook, metadata, field, or rollback summary shows the stored version of a page you may not have read in full: `get` again before your next full-content write.

Every save re-checks the whole page. A field that already existed without a name is reported as an advisory by `sys.artifact.validate_structure`, not refused, even if you restyle it (it is matched by its `id`, `name`, or `fabricId`); a new field you add must have a `label` (or `ariaLabel`). A save refused only for names says `ARTIFACT_FIELD_NAME_REQUIRED` and lists the fields: add the names and save again. Pass the `artifactId` to `validate_structure` when checking an edit, or old fields count as new.

## Versions

| Ref | Input | Use |
|---|---|---|
| `sys.artifact.rollback` | `artifactId`, `targetVersion` | Restore an older version (saved as a new version) |
| `sys.artifact.add_version` | `artifactId`, `content`, `expectedVersion`, `description` | Save a snapshot |
| `sys.artifact.delete_version` | `artifactId`, `version` | Delete one version |

`add_version` makes `content` the whole current page, so it follows the rewrite rule: it needs `expectedVersion` (the `version` from the last result that loaded the whole page or wrote your own whole content, as above), and a stale one is refused with nothing saved.

Confirm with the user before deleting a version or moving a published artifact to another zone.

## Settings without touching the page

- Zone: `sys.artifact.set_zone` (`artifactId`, `zone`), or `publish` with a `zone`.
- Webhook: `sys.artifact.set_webhook` (`artifactId`, `webhook_url`, `brain_type`).
- Model, system prompt, and zone also have per-artifact controls (`artifact.<id>.field.model.set`, `.field.system_prompt.set`, `.field.zone.set`).

## Multi-session builds (blueprint)

For a large artifact built over several sessions, keep the plan in its `blueprint` field: set it on create with the user's goal and plan, and append milestones as you go ("Step 2 done: form layout; AI wiring next"). When the user says "continue working on X", `get` it and read the blueprint first.

## Runs after an edit

If the artifact runs AI or a webhook, run it once after a behaviour change and read `sys.artifact.run_logs.get` if the output is wrong. Logs survive version edits, rollbacks, and version deletion, so compare runs across versions there.
