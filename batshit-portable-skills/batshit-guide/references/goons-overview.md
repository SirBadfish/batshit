# 3D Goons

Goons are Batshit's 3D avatars — expressive characters tied to your agents that animate, emote, lip sync, and react to cues while the agent speaks. They pair with [Voice](../voice/overview.md), but the visual avatar also stands on its own. This page is the mental model; for hands-on setup and packages, see [Goon setup and packages](setup-and-packages.md).

## Goons

Goons are 3D avatars assigned to agents. They can show in the Goon Dock, use moods and emotes, lip sync to voice, wear saved outfits, use scenes/props/room shells/skyboxes, and react to cues in assistant messages.

The Goon Dock is a right-sidebar surface. It's intentionally user-opened, because 3D runtime work can be heavy.

## Goon types

| Goon path | What it is |
| --- | --- |
| Standard/VRoid | A direct `.vrm` avatar import. The most straightforward user path. |
| Advanced/Blender | A `.bgoon` or `.zip` package containing `avatar.vrm` and `avatar.json`, created by a compatible Advanced/Blender authoring workflow. |
| Advanced/GLB | Expert custom package using `avatar.glb` and `avatar.json`. Implemented, but not the normal pre-launch UI path. |

VRM 1.0 is the full live avatar runtime format for launch. Advanced/Blender Goons still ride the VRM runtime, with extra manifest data for Batshit-specific face, outfit, and stage behavior. Starter Goons and the default Goon Pack are optional hosted downloads — they aren't bundled as large avatar or motion files inside the app package; importing them stores the assets in your instance.

## Lip sync

Batshit has two broad lip-sync paths:

| Path | What it means |
| --- | --- |
| Shitty but Fast | Quick amplitude/timing-based mouth movement. A good fallback. |
| Rhubarb WASM / provider visemes | Better mouth timing where supported. Completed-audio providers use Rhubarb WASM; Inworld realtime TTS can use provider phoneme/viseme timing live. |

Rhubarb WASM is an analyzer lane — it analyzes completed audio for mouth shapes, and it's not the same thing as LiveKit. Provider visemes are different: when a realtime TTS provider sends timing, Batshit can use that timing directly without waiting for Rhubarb analysis. Inworld is the current live provider-viseme path: with Inworld realtime TTS plus the Rhubarb WASM / Premium viseme lip-sync lane, Batshit drives the Goon mouth from Inworld's phoneme/viseme timestamps as audio plays.

Some Goons have more mouth shapes than others. Standard/VRoid avatars use their real five-mouth VRM contract, while Advanced/Blender avatars can use richer mouth shapes when the package manifest maps them. If lip sync is timed correctly but the mouth looks too closed or some words look visually weak, that is usually an avatar mouth-shape or manifest-authoring problem rather than a voice timing problem.

## Moods, emotes, and cues

A **Mood** is a persistent base expression or motion. It stays active until changed. An **Emote** is a one-shot expression or gesture, usually triggered by emoji or stage directions.

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
5. The Goon Dock receives playback timing.
6. Lip sync and emotes play against the voice timeline where possible.

If the Dock is closed, the agent can still speak — the visual avatar just isn't rendered.

## Group Chat

Group Chat can use voice, but it doesn't use Goons yet. The visual Dock shows one active Goon at a time, so Batshit closes/suppresses the Dock during group chats and keeps Goon cue instructions out of group prompts. Voice playback is queued by agent so multiple speakers don't talk over each other.

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
