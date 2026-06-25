# 3D Goons and advanced packages

3D Goons are expressive avatars for Batshit agents — they sit in the Goon Dock, react to chat cues, move with animations, wear saved outfits, and lip sync while an agent speaks. Giving your AI an actual face that emotes in 3D isn't something you'll find in other chat apps; it's one of Batshit's signature toys.

The runtime is VRM-first. Advanced authoring exists, but the live avatar path still centers on VRM-compatible behavior.

## Supported Goon types

| User-facing type | What you import | Launch posture |
| --- | --- | --- |
| Standard/VRoid Goon | A `.vrm` file | Primary supported path for normal users. |
| Advanced/Blender Goon | A `.bgoon` or `.zip` package containing `avatar.vrm` and `avatar.json` | Main advanced authoring path. Uses the VRM runtime with Batshit manifest metadata. |
| Advanced/GLB Goon | A package containing `avatar.glb` and `avatar.json` | Expert escape hatch. Full motion/outfit parity isn't launch-complete. |

VRM 1.0 is the only full live avatar runtime format today. Arbitrary humanoid models aren't guaranteed to work.

## Create a Standard/VRoid Goon

1. Open Settings → Goons.
2. Choose Create New Goon (Standard VRM / VRoid).
3. Upload a `.vrm` file.
4. Give it a clear name.
5. Save it.
6. Assign it to an agent in Agent settings.
7. Open the Goon Dock from the right sidebar.
8. Send a short message with TTS enabled if you want to test lip sync.

If the avatar loads but some expressions don't work, the VRM may be missing those blendshapes or bones. Batshit degrades visibly rather than pretending unsupported controls exist.

Starter Goons are offered as a download card, not bundled inside the app. When you choose one, Batshit downloads the allowlisted hosted VRM once and saves it through the same upload path as your own `.vrm` file.

## Create an Advanced/Blender Goon

Advanced/Blender Goons use a package, not a loose model file. The package must include:

- `avatar.vrm`
- `avatar.json`

The manifest can include stage anchors, face expression mappings, face control mappings, custom morphs, original outfit piece metadata, and spring bone metadata from the VRM export.

1. Prepare the character in Blender.
2. Validate and export the package with a compatible Advanced/Blender authoring workflow.
3. Open Settings → Goons.
4. Choose Create New Goon (Advanced/Blender).
5. Upload the `.bgoon` or `.zip` package.
6. Save the Goon.
7. Open the Goon Editor to check Wardrobe, Moods, Emotes, Eye Contact, and camera framing.
8. Assign the Goon to an agent.
9. Test in the Goon Dock.

Advanced/Blender packages and high-detail VRM files can be large. Batshit supports core Goon imports up to `600M`; Docker keeps a broader `BODY_SIZE_LIMIT=1G` app front-door limit for Admin restores and other trusted local imports, but batshit-server still applies the Goon-specific cap after the request reaches the upload service.

## Advanced/Blender authoring status

Batshit can import Advanced/Blender packages, but the first-party Batshit Blender addon isn't included in the public AGPL core snapshot for launch. Its distribution and license are post-launch scope.

When the addon is distributed, it's expected to wrap the Batshit-specific prep/export workflow:

- source snapshot before destructive prep
- mesh health checks
- shape-key freeze/rebase helpers
- rig cleanup guardrails
- Split Jobs for extraction or bake prep
- Kiln-aware bake prep and cleanup
- face slots and Rhubarb mouth cues
- custom morph capture
- stage anchor mapping
- Advanced/Blender outfit metadata
- package validation
- `.bgoon` package export

That authoring workflow doesn't replace Blender, the VRM add-on, Auto-Rig Pro, or Kiln.

## Advanced authoring dependencies

Required for Advanced/Blender export:

- Blender 4.2+
- VRM Add-on for Blender

Endorsed but not always required:

- Auto-Rig Pro for the highest-success Advanced/Blender humanoid authoring path

Required only for guided bake work:

- Kiln

Auto-Rig Pro is not a Batshit runtime dependency. You don't need it to run an already-exported Goon in Batshit.

## Basic Blender authoring flow

1. Open the character `.blend`.
2. Work on a copy.
3. Run the compatible authoring workflow's validation and export steps.
4. Confirm the package includes `avatar.vrm` and `avatar.json`.
5. Mark Advanced/Blender original outfit pieces where needed.
6. Assign stage anchors.
7. Validate the package.
8. Fix blockers.
9. Export the package.
10. Import the package into Batshit.

Don't continue past missing Blender dependencies or validation blockers. Bad packages should fail loudly instead of becoming mysterious runtime bugs.

## Stage Ready and Talk Ready

**Stage Ready** needs anchors that let Batshit place the character in scenes. The minimum anchor set includes head, upper chest, hips, and feet information.

**Talk Ready** needs usable face/mouth mappings so Batshit can drive speech and expressions. If a package isn't Talk Ready, it may still render, but mouth movement and expressive cues can be incomplete or unavailable.

## Goon Dock

The Goon Dock lives in the right sidebar and starts closed on app launch. Its controls are quick-access:

- Goon selection
- Scene selection
- Mood selection
- Closet/Wardrobe selection
- Motion previews
- Emote tests
- mouse-height zoom focus
- field of view
- quality
- immersive mode

Selecting Goon, Scene, Mood, or Closet from the Dock saves real state. Motion and Emote quick actions are for preview/testing and usually return to the saved Mood afterward. Only one visible active Goon renders at a time in v1.

## Voice and lip sync

Goons can lip sync to Batshit voice playback when the model has usable mouth blendshapes. Voice Settings → 3D Goon Lip Sync controls the global lane:

- Shitty but Fast
- Rhubarb WASM / provider visemes

Realtime TTS uses live analyser/timing behavior; Rhubarb WASM needs completed audio for precomputed visemes. Inworld realtime TTS can use provider-native phoneme/viseme timing live when Rhubarb WASM / provider viseme lip sync is selected, while Fish realtime TTS uses streamed audio/text timing without provider mouth-shape details. If lip sync doesn't work, first prove TTS audio plays, then check the Goon's Rig Health and mouth blendshape support. If the mouth moves on time but the shapes look bad, tune the authored mouth morphs and face-expression mappings.

## Motions

Batshit supports:

- VRMA animations in the shared Motion Vault
- Goon-specific animation files
- FBX uploads converted to VRMA when the converter is available

Native/local installs use the Admin-managed FBX2glTF installer for FBX conversion. Docker installs use the optional `fbx2vrma` worker profile:

```sh
docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker
```

VRMA is the recommended default for reusable animations. GLB/GLTF animation files are more likely to be rig-specific unless retargeted.

## Default Goon Pack

The launch default Goon Pack is an optional import, not a bundled app asset. This keeps the Mac app and Docker image smaller while still giving you a ready-made starter set.

[Download the default Goon Pack](https://batshit.ai/downloads/goons/batshit-goon-default-pack.zip), then import it from Settings → Goons → Kitchen → Import Pack.

The pack includes moods, emotes, emoji triggers, custom Stage Postures, and Motion Vault VRMA files. It does not include Scenes.

## Closet and Wardrobe

Batshit separates global clothing from per-Goon clothing state:

- **Global Closet** — shared `.xwear` item library.
- **Wardrobe** — per-Goon clothing assignments, edits, conceal painting, and saved outfits.

Advanced/Blender original outfit pieces can appear as Wardrobe rows when the package manifest defines them. Built-in `All Original` and `None` are runtime/editor actions, not saved outfit records. `Save Current Outfit`, `Update`, and `Delete` on named outfits save immediately. Conceal painting is authored inside Batshit Live Preview, not in the Blender addon.

## Scenes

Goon scenes can use skyboxes, room builder surfaces, uploaded room shells, props, posture markers, and room textures. Large or high-poly scene assets can hurt performance — take the UI guardrails seriously.

## Docker notes

Docker Batshit can run the Goon runtime and import Goon packages. Blender authoring still happens on the host machine in Blender, not inside the core Batshit app container.

- app is `http://localhost:5620`
- batshit-server is `http://localhost:5600`
- saved Goon asset URLs must be browser-facing, not `http://batshit-server:5600`
- FBX conversion uses the optional `fbx2vrma` worker
- Blender authoring is host-side

## Backup boundary

Batshit backups include active Batshit-owned Goon records and uploaded Goon assets. They do not include:

- Blender source `.blend` files
- external texture libraries outside Batshit uploads
- local Blender installs and addon installs
- Auto-Rig Pro, Kiln, or VRM Add-on installs
- external motion source libraries unless imported into Batshit

Keep your original Blender project files backed up separately.

## Known launch boundaries

- VRM 1.0 is the primary runtime.
- Advanced/GLB full motion/outfit parity isn't launch-complete.
- Arbitrary models aren't guaranteed to become compatible Goons.
- Facial control is blendshape-based.
- Animation retargeting isn't automatic.
- XWear overrides are material-focused; the target material must exist in the VRM export.
- Skyboxes are equirectangular in v1.

## Related docs

- [Voice](../voice/overview.md)
- [3D Goons overview](overview.md)
- [Voice, TTS, and STT](../voice/voice-settings.md)
