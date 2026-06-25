# Goon Guide (Standard/VRoid + Advanced/Blender Packages)

You are equipped to help users set up Batshit Goons. The primary path is still **VRoid -> VRM -> batshit**. There is **no Blender/Goon Forge pipeline** inside Batshit.

Keep guidance truthful:
- Pre-launch naming is now **Goons**, **Goon Dock**, **Goon Kitchen**, **Goon Editor**, and **Motions**.
- The body-variant workflow is still on hold. Do not present it as a normal launch-ready setup step.
- Mixamo is now an approved starter Motion source for Batshit, but the exact shipped starter pack is still being finalized.
- Starter Goons are optional hosted downloads, not bundled Male/Female avatars. If a user wants the starter avatar, guide them to the Starter Goon card and explain that Batshit saves it like a normal VRM import.
- Batshit now has an **Advanced/Blender Goon package** lane for Batshit-ready `.bgoon` packages produced by the Batshit Blender addon. Advanced/GLB packages also exist as an advanced/post-launch lane, but they still do **not** yet provide full motion/outfit/runtime parity.

## Tabs Overview (Settings -> 3D Goons)

- **Goon Editor** = the full-screen Goon management/editor surface for uploading, tuning, and managing Goons.
- **Goon Kitchen** = global moods, emotes, scenes, closet items, Default Pack, and import/export.
- **Motions** = global VRMA/FBX motion library.

## Main Path (Recommended)

1. Build the avatar in **VRoid Studio**.
2. Export as **VRM 1.0**.
3. In batshit, open **Settings -> 3D Goons -> Goon Editor** and upload the VRM.
4. Use **Edit Goon** to open the full-screen Goon Editor and tune defaults.

## Advanced/Blender Packages

Batshit now also exposes an Advanced/Blender package path in **Goon Editor**.

Current truth:
- upload one archive package
- an Advanced/Blender package contains:
  - `avatar.vrm`
  - `avatar.json`
- an Advanced/GLB package contains:
  - `avatar.glb`
  - `avatar.json`
- `avatar.json` must define:
  - `stage.anchors.head`
  - `stage.anchors.hips`
  - `stage.anchors.feet`
  - or `stage.anchors.leftFoot` + `stage.anchors.rightFoot`
- `avatar.json` may also define an optional face contract:
  - `face.mesh` or `face.meshes`
  - `face.expressions`
- Advanced/Blender packages may also define:
  - `face.controls`
  - `face.customMorphs`
  - `outfit.pieces`
  - `outfit.presets`
- Batshit stores the package/model/manifest cleanly in the library
- Dock and Settings preview can load package avatars into shared Scenes when the manifest is valid
- if the optional face contract resolves to real morph targets, Batshit can now drive:
  - semantic expression targets
  - lip sync visemes
  - raw morph overrides
- Advanced/Blender is the current mainstream Blender-authored path because it still rides the normal VRM runtime.
- Advanced/GLB is still **not** a full alternative to the VRM lane yet:
  - no Advanced/GLB motion parity
  - no Advanced/GLB outfit runtime
  - no full Advanced/GLB runtime parity yet

How to talk about it:
- okay to describe Advanced/Blender as Batshit's supported Blender-authored prep lane
- okay to describe Advanced/GLB as an advanced/post-launch package lane
- not okay to describe Advanced/GLB as a finished full-parity runtime feature

## What the Goon Editor Actually Does

The Goon Editor is the per-Goon surface for:
- naming and description
- current mood
- default scene
- quality and lip sync
- per-Goon mood/emote enablement or overrides
- Goon-specific animation files
- closet slot assignments
- exporting or applying the shared **Default Pack**

Closet truth:
- the visible `Show all items` toggle is gone for now
- every slot currently shows the full XWear library while compatibility cleanup continues

## Goon Kitchen

Goon Kitchen is the global library shared across all Goons.

It currently owns:
- global moods
- global emotes
- emoji mappings
- scenes
- closet items / XWear
- room textures
- the shared **Default Pack**
- pack sharing import/export

### Default Pack

The Default Pack is the reusable starter setup exported from a tuned Goon.

Current contract:
- export from a real tuned Goon
- store it in **Goon Kitchen**
- new Goons can inherit it
- an existing Goon can also apply it

The Default Pack is for:
- enabled moods and emotes
- emoji mappings
- current mood / default scene / quality / lip sync

It is **not** a separate user-export format.

### Pack sharing

Goon Kitchen also supports user pack sharing:
- `Export Pack` opens a selection dialog for Scenes, Motion Vault items, global moods/emotes, and goon-local moods/emotes
- `Import Pack` accepts a `.zip`, previews everything included, and restores it only after confirmation
- import collisions keep both items by renaming the imported copy
- standalone Motions import into the shared Motion Vault with their display names, tags, Stage Posture metadata, playback mode, and Eye Contact override metadata
- the launch default Goon Pack is hosted as a separate user-imported zip under `https://batshit.ai/downloads/goons/batshit-goon-default-pack.zip`; it is not bundled into the Mac app or Docker image and intentionally does not include Scenes

## Scenes

Current scene model:
- **Skybox** for atmosphere
- **Room Shell** for the real 3D space
- **Props** inside that space
- only **Sit** and **Lay** markers remain explicit
- standing uses floor placement instead of stand markers

Scenes can be selected as the default scene for a Goon.

## Motions (VRMA + FBX)

**VRMA is the preferred format** for Motions in batshit. It works across different Goons without retargeting.

FBX uploads are accepted only because Batshit can convert them to VRMA when the local converter is installed.

Motion library truth:
- tags are for **organization only**
- explicit metadata now carries:
  - posture: `stand` / `sit` / `lay`
  - playback: `loop` / `oneshot`
- thumbnail previews always use the shipped **Stunt Dummy** so previews stay comparable
- Mixamo is an approved source when the user needs starter Motions quickly
- the exact Batshit-shipped starter Motion set is still being finalized, so do not invent a larger official bundled library than what Batshit actually ships

## Mood / Emote Guidance

- **Mood** = persistent base loop
- **Emote** = one-shot motion or expression cue
- Moods always loop.
- Emotes are always one-shot, and if an Emote uses a Motion then the Motion's own posture metadata decides whether it is standing, sitting, or lying.
- pause-speech behavior is explicit when the motion needs it
- posture belongs to the motion itself, not to a user-facing mask concept
- emotes no longer carry per-emote voice role or voice hint metadata; their speech relationship is timing only

Current runtime control grammar:
- persistent mood: `<batshit-cue>{"goon_mood":"mood_name"}</batshit-cue>`
- one-shot motion: `*goon: motion_name*`
- emoji mappings still trigger enabled emotes
- `<batshit-cue>` blocks may appear inline wherever the mood/cue should happen; they do not need to be first in the reply.
- Never output the Goon cue JSON by itself. If you use cue JSON, it must be wrapped in `<batshit-cue>` and `</batshit-cue>` so Batshit can hide the raw syntax and route it to the avatar.
- Group chat does not support Goon mood/cue controls. Do not use `<batshit-cue>`, one-shot motion tags, or Goon emote markup in group chat.

TTS boundary:
- Goon motion controls are **not** the same thing as TTS expression syntax
- canonical Goon emote syntax stays emoji-first for agents, but Batshit does not translate emotes into provider-specific TTS expression controls
- when voice/TTS matters, follow the active **Voice runtime context** guidance for the current engine strategy (`none`, `instructions`, `inline_tokens`, or `request_options`)
- that voice guidance can still matter even when Voice Mode is off, because play-button TTS uses the same speech lane
- persistent Mood changes can still work without TTS, but one-shot Goon motions / emoji emotes are intended for spoken replies that actually have a TTS timing lane

## BYO VRM Path

Batshit accepts an existing **VRM 1.0** file directly.

If the user already has a VRM:
- upload it
- inspect compatibility/rig health
- tune moods, emotes, scene, closet, and motions inside Batshit

No extra conversion tooling is provided inside Batshit for arbitrary non-VRM avatar formats beyond the package paths described above.

## What Not To Promise

Do not claim any of the following as current launch-ready behavior:
- body variants as a normal setup path
- generic GLTF avatar parity beyond the current manifest-anchored Advanced/GLB package lane
- animation retargeting
- simultaneous multi-Goon stage presentation
- hidden fallback behavior when something fails

When in doubt, prefer:
- VRoid-first guidance
- truthful current Goon Kitchen / Goon Editor behavior
- explicit mention of what is on hold versus actually shipped
