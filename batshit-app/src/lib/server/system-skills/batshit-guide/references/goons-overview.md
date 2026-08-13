# 3D Goons

Goons are Batshit's 3D avatars — expressive characters tied to your agents that animate, emote, lip sync, and react to cues while the agent speaks. They pair with [Voice](../voice/overview.md), but the visual avatar also stands on its own. This page is the mental model; for hands-on setup and packages, see [Goon setup and packages](setup-and-packages.md).

## Goons

Goons are 3D avatars assigned to agents. They can show in the Goon Dock or, in the packaged Mac app, move into Desktop Mode as a transparent desktop companion. They use moods and emotes, lip sync to voice, wear saved outfits, use scenes/props/room shells/skyboxes in Batshit, and react to cues in assistant messages.

The Goon Dock is a right-sidebar surface. It's intentionally user-opened, because 3D runtime work can be heavy.

## Goon types

| Goon path | What it is |
| --- | --- |
| Standard/VRoid | A direct `.vrm` avatar import. The simplest user path, with VRoid's real expression and mouth-shape limits. |
| Advanced/GLB | A first-party or expert custom package using `avatar.glb` and `avatar.json`. Supported first-party packages prepare automatically, making this the nearly-as-simple but much richer Batshit-owned path. |
| Advanced/Blender | A `.bgoon` or `.zip` containing `avatar.vrm` and `avatar.json`, created through the most advanced authoring workflow. It is intended for Blender artists and newcomers willing to follow the full preparation, mapping, validation, and export guide. |

Standard/VRoid and Advanced/Blender Goons use the VRM 1.0 runtime. Advanced/GLB Goons use an explicit package manifest for their stage, face, appearance, rig, and baked runtime contracts; arbitrary GLB humanoids are not automatically compatible. Starter Goons and the default Goon Pack are optional hosted downloads — they aren't bundled as large avatar or motion files inside the app package; importing them stores the assets in your instance.

All three are supported product lanes, but they intentionally require different amounts of authoring work. Advanced/Blender is first-class expert support: Batshit provides the compatible add-on workflow, exact mapping rules, clear validation failures, runtime support, and documentation. It does not promise that an arbitrary Blender character becomes ready without rig, blendshape/shape-key, anchor, and export work.

Independent artists can use that expert lane to offer original, commissioned, or properly licensed Batshit-ready models and conversion services. "Batshit-ready" describes technical compatibility only; it does not prove that an artist owns a character or has permission to redistribute it. Buying or locating a model—including a model extracted from a game—does not automatically grant resale rights. Batshit does not host or supply third-party game-character models. Check the model license and the rights holder's current policy before sharing or selling anything.

## First-party Advanced/GLB Goons

The ordinary first-party Advanced/GLB flow is **upload, edit, and Save Goon**:

- After upload, Batshit shows **Preparing** and creates the first verified runtime version automatically. The Goon is not assignable or available in the Dock until it reads **Ready**.
- You can batch face and body edits inside **Custom Goon Builder**, then click **Save Goon** once. One saved appearance batch produces one checked internal update.
- Mood, Emote, Motion, camera, Eye Contact behavior, voice, and ordinary runtime-only wardrobe/settings saves do not rebuild geometry.
- A failed update leaves the previously working Goon usable. **Retry** resumes verified stored work; **Discard** removes only unreferenced pending work.
- **Restore Previous Version** swaps the complete prior package, appearance, artwork, eye state, and runtime version together.

When a newer supported package is available, choose **Update Goon File**. Batshit offers **Update Goon** only when exact proof passes, **Reset Appearance and Update** only after a safe reset is proven and confirmed, or a clear blocked/ineligible result. **Keep Current** leaves the existing Goon untouched. Exact internal identities, stages, revisions, and proof remain available under **Technical Details** for support and authors.

The first Blender-author update contract is limited to supported first-party Advanced/GLB exports. Loose GLBs, hand-patched packages, and independently authored Advanced/GLB updates are not assumed compatible from names or visual similarity. See [Goon setup and packages](setup-and-packages.md#advancedglb-preparation-and-updates) for the full flow and compatibility matrix.

## Lip sync

Batshit has two broad lip-sync paths:

| Path | What it means |
| --- | --- |
| Shitty but Fast | Quick amplitude/timing-based mouth movement. A good fallback. |
| Rhubarb WASM / provider visemes | Better mouth timing where supported. Completed-audio providers can use Rhubarb WASM; Inworld realtime TTS can use provider phoneme/viseme timing live. |
| NVIDIA Audio2Face | Optional completed-audio full-face ARKit animation for compatible Advanced/GLB Goons through a separate NVIDIA GPU runtime. |

Rhubarb WASM is an analyzer lane — it analyzes completed audio for mouth shapes, and it's not the same thing as LiveKit. Provider visemes are different: when a realtime TTS provider sends timing, Batshit can use that timing directly without waiting for Rhubarb analysis. Inworld is the current live provider-viseme path: with Inworld realtime TTS plus the Rhubarb WASM / Premium viseme lip-sync lane, Batshit drives the Goon mouth from Inworld's phoneme/viseme timestamps as audio plays.

Some Goons have more mouth shapes than others. Standard/VRoid avatars use their real five-mouth VRM contract, while Advanced packages can declare either Batshit's Rhubarb-9 authoring profile or the exact OVR-15 profile used by Inworld timing. Compatible first-party Advanced/GLB packages receive Audio2Face ARKit-52 frames directly; Advanced/Blender packages receive the same full-fidelity face drive only after their manifest explicitly maps all 52 channels. Optional 16-channel tongue output also requires a complete explicit tongue map. Batshit keeps the provider or analyzer detail through playback, then adapts it to the selected Goon only at the final face-mapping step. If lip sync is timed correctly but the mouth looks too closed, robotic, or visually weak on some words, that is usually avatar-specific mouth-shape/expression calibration rather than a voice-timing failure.

## Moods, emotes, and cues

A **Mood** is a persistent base expression or motion. It stays active until changed. An **Emote** is a one-shot facial expression, usually triggered by emoji. Body gestures and other one-shot animations are **Motions**, not Emotes; agents trigger those with a `*goon: motion_name*` stage direction.

Every Goon type uses the same five facial presets when you author a Mood, Emote, or expression step: **Happy, Relaxed, Sad, Angry, and Surprised**. Batshit adapts them to the selected model's real capabilities. **Reset Face** returns the Goon to its authored Neutral resting face; Neutral does not need its own slider or blendshape. If that model does not map one of the five presets, the control stays visible and says **Unavailable** instead of disappearing or looking broken. The editor then exposes the face regions the model can actually drive, while search and changed counts keep large Advanced/GLB control sets manageable.

Those expression recipes are separate from speech mouth shapes. A facial expression can share a basic control such as opening the jaw, but Batshit does not use an O vowel or another viseme preset as a shortcut for Surprised, Happy, or the other semantic expressions.

Agents can cue Goons with:

- Emoji triggers.
- `*goon: cue_name*` stage directions.
- `<batshit-cue>` blocks that are hidden from the visible chat, placed inline wherever the mood or cue should happen.

Speech cleanup removes Goon cue markup before sending text to TTS, so the voice speaks normal prose instead of reading cue tags.

## Voice and Goons together

When an assistant reply is spoken:

1. Batshit resolves the active voice provider/settings.
2. The assistant text is cleaned for speech.
3. Goon cues are parsed from the original reply.
4. TTS begins or streams.
5. The active Goon surface — Dock or Desktop Mode — receives playback timing.
6. Lip sync, facial Emotes, and one-shot Motions play against the voice timeline where possible.

If neither the Dock nor Desktop Mode is active, the agent can still speak — the visual avatar just isn't rendered.

## Desktop Mode (Mac app)

In the packaged Mac app, use the monitor button in the Goon Dock to move the active Goon into a transparent desktop window. Batshit keeps the chat, microphone, speech recognition, voice playback, interruptions, and session running in the main window; Desktop Mode renders the same Goon and never starts a second audio or microphone owner.

Desktop Mode shows only one Goon. It does not bring the room, skybox, chat, captions, or Batshit controls onto the desktop. Dock, Immersive, and Desktop Mode are mutually exclusive, and the Goon tab in the main window becomes a reliable **Close Desktop Goon** action while Desktop Mode is active.

While a Goon is visible, Batshit tells the active agent whether it is appearing in the Goon Dock, Immersive Mode, or Desktop Mode and keeps its normal Mood, Emote, outfit, and voice-cue guidance. In Desktop Mode, the agent is told that its live 3D Goon is literally visible in a transparent, scene-free window on your operating-system desktop, rather than inside a saved Batshit scene. This is presentation awareness, not screen vision: the agent cannot see your wallpaper, windows, apps, or anything else on the desktop unless you share it in chat.

Desktop Mode opens with the camera, framing, FOV, and rotation you already chose in the Goon Dock, so the Dock acts as the staging view. Animation, expression, outfit, Hair motion, lip sync, and the conversation continue normally. Closing Desktop Mode leaves the Goon Dock closed; open the Dock whenever you want the Goon back inside Batshit, then send it to the desktop again once it is ready.

The small **Desktop Controls** island can remain visible while Batshit is minimized. It stays above the Goon and remains clickable even when the large Goon window is click-through or set to Stay on Top. The paperclip stays on the left, active Clip tokens appear after it, and the right-side **Mood**, **Closet**, **Quality**, and **Eye Contact** controls follow the Clips; Eye Contact sits directly beside Voice. These controls use the same Goon state as their Goon Dock counterparts. The paperclip picks files, and files can still be dropped anywhere on the island even though no `Drop files` label is shown. The island also unclips current attachments, starts or ends Voice Mode, closes the Desktop Goon, and turns on **Adjust**. Goon Stay on Top and Lock each use a bordered two-sided icon control whose filled side shows the current state; the Hand means the Goon is adjustable, while the Lock means the Goon is fixed and clicks pass through it. The global shortcut shows or hides the island.

Adjust exposes the Goon frame only while you need it: drag the handle to move it, resize horizontally, scroll or use the trackpad to zoom, left-drag to move through a limited vertical camera orbit, hold left and right together while dragging to pan, right-drag to rotate the Goon, and Shift+scroll to adjust field of view. The orbit stops slightly below eye level and before extreme overhead angles; horizontal/free orbit is intentionally unavailable. Turning Adjust off—or hiding the island with the shortcut—restores the saved Click-Through behavior and removes the frame outline.

The configurable global Desktop Controls shortcut defaults to Command+Shift+G on Mac and is recorded by pressing the desired chord in Settings; users never need to type Electron syntax. Press it to show or hide the island from any app. Settings → 3D Goons → Desktop Mode also controls Full Height, starting width, Goon Stay on Top, Goon Click-Through, the shortcut, and **Desktop Visibility** (`This Desktop` or `All Desktops`) on macOS. Exact Goon and island placement stays on that computer, while Clips and Voice Mode continue to belong to the active Batshit chat. Desktop Mode never turns itself on automatically after launch.

Mac is the supported Desktop Mode platform in this release. Browser, Docker, and source-web sessions cannot create an operating-system overlay. The shared Electron design includes a Windows-safe policy contract, but Batshit does not claim Windows support until a separately packaged and signed Windows build passes real Windows testing.

## Group Chat

Group Chat can use one visible Goon at a time. During audible playback, the Dock or Desktop Mode follows the agent whose voice is actually playing; while a response is streaming it follows that current speaker. When the group is idle, a valid configured Group driver is the visual fallback, followed by the current agent. Voice playback remains queued so speakers never talk over each other, and Batshit never opens multiple Goon renderers for a group.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Goon mouth doesn't move | The avatar lacks usable mouth shapes, the Dock is closed, or the lip-sync lane is unavailable. | Goon Rig Health and Voice Settings lip sync. |
| Goon mouth moves on time but looks wrong | The runtime has timing, but the authored mouth expressions are too subtle, missing, or mapped poorly. | Blender/VRM mouth morphs and `avatar.json` face-expression mappings. |
| Advanced/Blender Goon import fails | The package is missing `avatar.vrm` or `avatar.json`, or manifest anchors are invalid. | Re-export with a compatible Advanced/Blender authoring workflow. |

## Related docs

- [Goon setup and packages](setup-and-packages.md)
- [Voice](../voice/overview.md)
- [Group Chat](../groups/overview.md)
- [Security and trust](../security/overview.md)
