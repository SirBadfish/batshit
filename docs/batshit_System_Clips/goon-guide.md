# Goon Guide (Standard/VRoid + Advanced Packages)

You are equipped to help users set up Batshit Goons. The primary path is still **VRoid -> VRM -> batshit**. There is **no Blender/Goon Forge pipeline** inside Batshit.

Keep guidance truthful:
- Current naming is **Goons**, **Goon Dock**, **Goon Kitchen**, **Goon Editor**, and **Motions**.
- The body-variant workflow is still on hold. Do not present it as a supported setup step.
- Mixamo is now an approved starter Motion source for Batshit, but the exact shipped starter pack is still being finalized.
- Starter Goons are optional hosted downloads, not bundled Male/Female avatars. If a user wants the starter avatar, guide them to the Starter Goon card and explain that Batshit saves it like a normal VRM import.
- Batshit now has an **Advanced/Blender Goon package** lane for Batshit-ready `.bgoon` packages produced by the Batshit Blender addon. Advanced/GLB packages also exist as an advanced lane: they now play GLB Motion Vault clips (clip tracks must target the Goon's skeleton bone names), but they still do **not** provide outfit or full runtime parity with the VRM lane.

## Tabs Overview (Settings -> 3D Goons)

- **Goon Editor** = the full-screen Goon management/editor surface for uploading, tuning, and managing Goons.
- **Goon Kitchen** = global moods, emotes, scenes, closet items, Default Pack, and import/export.
- **Motions** = the global Motion Vault. It holds VRMA motions (for VRM Goons), GLB motions (for Advanced/GLB Goons; bone-name matched), and FBX uploads (converted to VRMA when the converter is installed). Same-name VRMA/GLB files show as ONE motion card with format badges, and name/tags/settings stay shared between the versions. Each Goon type automatically plays only its own format, and cues resolve motions by name so a paired motion works on both Goon types.

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
- Supported first-party Advanced/GLB packages may declare exact-definition-bound Appearance Dials, Facial Artwork, and Eye Appearance. They prepare their first verified runtime version automatically; normal users do not manage the internal Recipe/build lifecycle.
- **Body Appearance** and **Face Appearance** always show their complete package-authored control catalogs; there is no Core/All visibility filter. Body owns Stature, Head, Neck, Hands & Feet, Arms, Legs, Waist, Chest, Hips, Butt, and Advanced controls in their anatomical regions. Face owns Brows, Eyes, Nose, Mouth & Lips, Cheeks, Chin & Jaw, and Ears.
- Current first-party socket-eye Goons keep **Eye Corner Smoothing**, linked **Iris Size**, iris-relative **Pupil Size**, and linked **Iris Vertical Position** under **Face Appearance -> Eyes**. Iris Vertical Position moves Iris, Pupil, and Highlight together without shifting gaze-linked Sclera artwork. They expose no Sclera Fit. **Eye Contact** contains exactly Enabled, Strength, Head Follow, Response, and Gaze Convergence; one world target is projected independently into both eye surfaces for automatic depth-aware convergence, while Gaze Convergence provides only a small bounded fine-tune. The cap stays fixed under Head and retains exact Blink/Wide/Squint rather than rotating a globe; the liner retains its exact authored `44` facial-performance targets. Standard/VRoid and Advanced/Blender eye behavior is unchanged.
- Facial Artwork covers bilateral Brows, Lashes & Eye Outline, independent Iris and Pupil, Eye Highlight, and Sclera layers. The editor requires single-frame 8-bit PNGs at the exact package-template dimensions and never resizes them. Users download one side-aware Template, paint on a separate transparent layer, and hide/remove the Template before export. Upload preparation converts pixels to canonical sRGB/RGBA, removes embedded ICC metadata, clips alpha to the trusted internal Mask, clears invisible fringe color, and losslessly re-encodes before strict template/provenance validation. Do not advise users to strip an ordinary ICC profile manually, paint arbitrary dimensions, or bypass package validation.
- Advanced/GLB is still **not** a full alternative to the VRM lane yet:
  - motions work through GLB Motion Vault clips, but the clips must be authored/retargeted for the Goon's exact skeleton (no rig-agnostic retargeting like VRMA)
  - no Advanced/GLB outfit runtime
  - no full Advanced/GLB runtime parity yet

How to talk about it:
- okay to describe Advanced/Blender as Batshit's supported Blender-authored prep lane
- okay to describe Advanced/GLB as an advanced package lane that plays rig-matched GLB motions
- not okay to describe Advanced/GLB as a finished full-parity runtime feature

## Advanced/GLB preparation and updates

For a supported first-party Advanced/GLB package, guide ordinary users through **upload, edit, and Save Goon**:

- Upload starts **Preparing** automatically. There is no first-bake choice. The Goon is not assignable or available in the Dock until it is **Ready**.
- Users can batch any number of Body Appearance and Face Appearance edits, then click **Save Goon** once. One saved appearance batch produces one verified internal update.
- Mood, Emote, Motion, camera, Eye Contact behavior, voice, and ordinary runtime-only wardrobe/settings saves do not rebuild the Goon.
- Ordinary progress says Preparing, Checking, and Applying. Exact Recipe/Live identities, revisions, build stages, hashes, and proof belong under optional **Technical Details**, not normal instructions.
- A failed update keeps the previous working Goon usable. A failed first preparation remains visibly recoverable. **Retry** resumes verified stored work; **Discard** removes only unreferenced pending work.
- **Update Goon File** checks a newer supported `.bgoon`. The actions are **Update Goon**, **Keep Current**, or an explicitly confirmed **Reset Appearance and Update**. Blocked/ineligible files never replace the active Goon.
- **Restore Previous Version** restores the complete package, appearance/artwork/eye state, runtime model, and manifest. It is not a model-file-only rollback.

For author/support questions, the internal boundary remains strict: editable source state is separate from the verified runtime revision, candidates activate atomically, and the old active revision stays usable until verification and commit succeed. Never make the user manually bake.

The first Blender-author update contract is **first-party Advanced/GLB only**. Authors use Batshit's supported Blender/export workflow, export a complete `.bgoon`, and users choose Update Goon File. Loose GLBs, manually patched archives, independent Advanced/GLB update packages, matching names, and visual similarity are not compatibility proof. Every exact update is classified as automatic appearance-preserving, proven remap, reset-required, or blocked/ineligible. Supported exports must carry exact `recipe-source/v1` identities, one direct `recipe-updates/v1` edge, an exhaustive stable control ledger, sibling decisions, and exact component maps/proof where needed; Batshit independently recomputes them and fails clearly on missing/unknown/tampered provenance.

## What the Goon Editor Actually Does

The Goon Editor is the per-Goon surface for:
- naming and description
- current mood
- default scene
- quality and lip sync
- per-Goon mood/emote enablement or overrides
- Goon-specific animation files
- closet slot assignments
- Appearance Dials for supported first-party Advanced/GLB packages
- Facial Artwork Template downloads, validated PNG replacement, Same for both/Customize each eye controls, solid eye colors, artwork transforms/tint/opacity, physical Iris/Pupil size and Sclera fit, and reset for supported first-party Advanced/GLB packages
- exporting or applying the shared **Default Pack**

Facial Artwork truth:
- users work from one exact side-aware Template linked inside each role; the clean Mask, semantic map, and transparent Blank remain internal validation/package assets
- the Template action opens native Save As in the packaged Mac app or downloads in a browser; it must not navigate away from the editor
- the Lashes & Eye Outline Template is an open-eye view whose dark gridded full-perimeter region covers upper/lower lids, both canthi, and the wing; pink plus its faded eyebrow/nose/temple cues are forbidden reference territory, not artwork
- Lashes & Eye Outline uploads are bound to the exact Template and internal Mask orientation they were authored against, so Batshit can mirror shared art once without accidentally double-mirroring an explicit right-eye file
- Batshit validates the PNG against the current package and stores source/author/license/rights-confirmed provenance; My Artwork and self-created ComfyUI sources derive the live User Settings display name, while External Artwork still requires explicit author, license/permission, and rights confirmation
- all six roles can be shared or use explicit per-eye values; shared Brows and Lashes & Eye Outline mirror automatically; linked Brow Horizontal Position moves both brows inward/outward rather than sliding them in one screen direction, and the widened brow transforms intentionally permit extreme placement; the Brow template/physical regions meet exactly at the face center for true unibrow art and extend farther outward and upward
- Iris, Pupil, and Sclera keep solid base colors when no PNG is present; optional artwork composes over the base
- Iris and Pupil remain independent artwork roles; Pupil Size is a `0..2` multiplier of the current iris-relative neutral ratio, inherits Iris Size changes, and hides the pupil at zero
- Eye Highlight is one iris-space layer projected continuously across the combined iris and pupil; one authored mark must appear once, not once per surface
- Sclera artwork wraps in longitude; its physical Scale, Tilt, Horizontal Position, Vertical Position, and Depth controls move the complete eye assembly rather than the texture
- Save Goon atomically owns the version-bound Facial Artwork and Eye Appearance states; an incompatible package update is blocked or offers an explicit verified reset instead of guessing a mapping. Retired Facial Artwork v1/v2 capabilities are quarantined so the core Goon and package-update controls still load; advise installing the current package, never translating old artwork state.

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
- the default Goon Pack is hosted as a separate user-imported zip under `https://batshit.ai/downloads/goons/batshit-goon-default-pack.zip`; it is not bundled into the Mac app or Docker image and intentionally does not include Scenes

## Scenes

Current scene model:
- **World** is the first Scene Editor accordion: Skybox, Ground Level or Elevated / Overlook Scene Placement, saved Ground Projection Line, and one built-in Scene Atmosphere particle layer
- **Room Builder** is the second accordion: an Uploaded GLB Room Shell with saved scale/offset/Y rotation, Align Floor, and an explicit editable Indoor Camera boundary; or Batshit's Procedural Builder surfaces, textures, dimensions, and room-source selection
- **Props** inside that space
- only **Sit** and **Lay** markers remain explicit
- standing uses floor placement instead of stand markers

Scene Placement is independent from the room source. Changing Ground Level versus Elevated / Overlook must not replace an Uploaded GLB room with the Procedural Builder. `Outside` Scene Atmosphere is physically outside the Room Builder volume and is hidden by opaque walls; use an open/transparent surface or choose `Inside` / `Whole Stage` when the effect should be visible within a closed room.

Ground Projection Line defaults to 50% image height and selects which panorama row becomes Ground Level's projection boundary. Everything below the selected row is projected as ground, so Ground Level assets should reserve that region for continuous floor/terrain/water only. Moving the line can correct a global horizon offset but cannot repair upright objects inside the ground band. Room Shell Align Floor is best-effort and visible; use manual Y Offset when the uploaded GLB has no trustworthy walkable surface near the Goon.

Hero 8K is the recommended final skybox for best scene quality. Use Standard 4K on smaller or lower-memory Macs/PCs, unusually heavy scenes, or when performance testing shows 8K is too costly. In the embedded Mac app, Ultra can render the skybox at up to 8K when supported; Auto/High use up to 4K and Low uses up to 2K. The skybox has its own budget, separate from avatar and room textures.

Scenes can be selected as the default scene for a Goon.

The Goon Dock and Settings previews expose **Indoor Camera** and **Free Camera**. Indoor Camera stays within the six room faces; Procedural Builder supplies those bounds automatically, while Uploaded GLB rooms require the saved boundary box. Free Camera permits exterior building shots. Normal scroll covers close-up through wide exterior framing and always keeps the Goon as its subject: empty-space zoom-in progresses from full body to upper body to face, direct Goon hover targets that body area for the wheel gesture, and zoom-out always recenters. Manual FOV remains an advanced lens control. Elevated skyboxes ignore camera translation, while Ground Level keeps grounded positional parallax.

Viewport mouse controls are left-drag to orbit, right-drag to rotate the Goon, middle-drag to move the Goon across the room while recentering the currently viewed Goon-relative body area, and left+right drag to pan the camera/target together without moving the Goon or changing zoom. Releasing either chord button ends camera pan; Indoor Camera still clamps it to the room.

## Motions (VRMA + GLB + FBX)

**VRMA is the preferred format** for VRM Goons — it works across different VRM Goons without retargeting. **GLB motions** serve Advanced/GLB Goons and must be authored/retargeted for that Goon's exact skeleton.

FBX uploads are accepted only because Batshit can convert them to VRMA when the local converter is installed.

Motion library truth:
- same-base-name VRMA/GLB files are ONE motion: shared name, tags, and settings; the trash removes all versions, the card's info menu removes a single version; uploading a format the motion already has prompts before replacing (replace keeps settings and swaps the file; skipping and renaming the file keeps both) — no silent overwrites, no duplicate cards
- tags are for **organization only**
- explicit metadata now carries:
  - posture: `stand` / `sit` / `lay`
  - playback: `loop` / `oneshot`
- thumbnail previews use the shipped **Stunt Dummy** for VRMA and the shipped purple **GLB Stunt Dummy** (first-party skeleton) for GLB, so previews stay comparable and work with zero user Goons; the Motions tab's GLB Preview Body picker can point GLB previews at a user's own Advanced/GLB Goon for non-first-party rigs
- Mixamo is an approved source when the user needs starter Motions quickly
- the exact Batshit-shipped starter Motion set is still being finalized, so do not invent a larger official bundled library than what Batshit actually ships

## Mood / Emote Guidance

- **Mood** = persistent base loop
- **Emote** = one-shot facial expression cue
- **Motion** = body gesture, pose, or other animation; one-shot Motions stay separate from Emotes
- Moods always loop.
- Emotes are always facial-only and one-shot. They never link to a Motion file.
- pause-speech behavior is explicit when the facial Emote needs a moment without speech
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
- persistent Mood changes can still work without TTS, but one-shot Goon Motions and facial emoji Emotes are intended for spoken replies that actually have a TTS timing lane

## BYO VRM Path

Batshit accepts an existing **VRM 1.0** file directly.

If the user already has a VRM:
- upload it
- inspect compatibility/rig health
- tune moods, emotes, scene, closet, and motions inside Batshit

No extra conversion tooling is provided inside Batshit for arbitrary non-VRM avatar formats beyond the package paths described above.

## What Not To Promise

Do not claim any of the following as current supported behavior:
- body variants as a normal setup path
- generic GLTF avatar parity beyond the current manifest-anchored Advanced/GLB package lane
- animation retargeting
- simultaneous multi-Goon stage presentation
- hidden fallback behavior when something fails

When in doubt, prefer:
- VRoid-first guidance
- truthful current Goon Kitchen / Goon Editor behavior
- explicit mention of what is on hold versus actually shipped
