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
7. Open the Goon Editor to check Body Appearance, Face Appearance, Wardrobe, Moods, Emotes, Eye Contact, and camera framing.
8. Assign the Goon to an agent.
9. Test in the Goon Dock.

Advanced/Blender packages and high-detail VRM files can be large. Batshit supports core Goon imports up to `600M`; Docker keeps a broader `BODY_SIZE_LIMIT=1G` app front-door limit for Admin restores and other trusted local imports, but batshit-server still applies the Goon-specific cap after the request reaches the upload service.

First-party Advanced/GLB packages can include versioned shape controls under **Body Appearance** and **Face Appearance**. Body Appearance owns Stature, Head, Neck, Hands & Feet, Arms, Legs, Waist, Chest, Hips, Butt, and Advanced. Face Appearance owns Brows, Eyes, Nose, Mouth & Lips, Cheeks, Chin & Jaw, and Ears. Head and forehead-shape controls stay with the body silhouette; Forehead Tighten and Brow Angle are under Brows, while Face Fullness is under Cheeks. Saved values live with the Goon and update the open Goon Dock without a browser or app reload. Package-owned Sclera Scale, Tilt, Horizontal Position, Vertical Position, and Depth appear under **Face Appearance -> Eyes -> Sclera Fit** because they resize or reposition physical eye geometry. **Eye Convergence (Gaze)** appears with the per-Goon **Eye Contact** controls instead. Its displayed `0°` is the package-calibrated neutral; positive values turn both eyes farther inward toward a nearer focus and negative values produce a farther gaze. Batshit validates the package's exact morph, follower, joint, and dynamic-face ownership before enabling the controls; malformed packages fail clearly instead of loading a partial identity system.

Appearance Dial values are bound to the exact package definition and neutral recipe. A compatible package update keeps valid values and removes stale controls. An incompatible update resets to that package's neutral and tells you it did so. Updating an older first-party Body Dials package is a clean v2 cutover: the old values reset because they cannot be mapped safely onto the new zero-centered controls.

Supported first-party Advanced/GLB packages can also include facial artwork inside **Face Appearance**. Open **Brows -> Brow Artwork** for brows. Open **Eyes** for separate **Lash & Outline Artwork**, **Iris Artwork**, **Pupil Artwork**, **Eye Highlight Artwork**, and **Sclera Artwork** sections. Each artwork header keeps its description behind the adjacent info icon, and each section provides one exact **Template** for the active anatomical side. Clicking it opens Save As in the packaged Mac app or downloads it in a browser; it does not navigate away from the editor. Use the Template as a reference layer, paint on a separate transparent layer, then hide or remove the Template before exporting a single-frame, 8-bit PNG at its exact dimensions. Batshit never resizes Facial Artwork. During upload, Batshit converts the pixels to canonical sRGB/RGBA, removes embedded color-profile metadata, clips transparency to the package's trusted internal Mask, clears invisible fringe color, and losslessly re-encodes the stored PNG before validating package/template identity and source rights. This lets ordinary Photoshop and AI-generated PNGs work without requiring you to remove an ICC profile yourself.

The Lashes & Eye Outline Template is shaped like an open eye. Its dark gridded region provides full-perimeter room for the upper lid, lower lid, both corners, and outer wing; pink is forbidden. The faded eyebrow, nose/temple marks, labels, and grid make the anatomical side obvious but are instructions only. Use the explicitly labeled Goon Left Eye Template for canonical shared artwork, or download the Goon Right Eye Template when authoring a right-eye override. Batshit binds the upload to that exact Template and internal Mask orientation so it mirrors the texture exactly once and rejects or clips pixels outside the safe region.

Every artwork role supports **Same for both** or **Customize each eye**. Shared Brows and Lashes & Eye Outline mirror the artwork automatically; you can still supply different left/right art when the character is intentionally asymmetrical. With shared Brows, Horizontal Position moves both brows closer together or farther apart instead of sliding both toward the same side. The Brow template and physical regions extend all the way to the face center with no built-in gap, so artwork may form a true unibrow, while the outer edge stays short of the temple/hairline. For Brows, Lashes, Iris, Pupil, and Eye Highlight, moving **Vertical Position** to the right moves the artwork up; moving it left moves the artwork down. **Scale `1`** is the package-calibrated full-size neutral for each role, with room to make the artwork smaller or larger. Brow scale tops out at `1.4`. Iris and Pupil remain independent: each can use a solid color with no artwork and add optional artwork over that color. **Pupil Size** ranges from `0` to `2` and is relative to the current Iris Size, so changing Iris Size also carries the pupil with it; `0` hides the pupil and `1` keeps the neutral pupil-to-iris ratio. Eye Highlight applies one authored catchlight continuously across the combined iris and pupil, so one painted mark appears once. Sclera also has a solid base color plus optional wrapped artwork.

For artwork you made, choose **My artwork** or **Made by me with ComfyUI**. Batshit credits the display name from User Settings and treats pressing Upload as your confirmation that you may use your own work. If that display name is missing, Batshit tells you to add it instead of inventing a credit. Choose **External artwork I may use** for someone else's work; that path still requires the author/source, license or permission, and an explicit rights confirmation for every upload.

Face Appearance keeps the linked Iris Size and iris-relative Pupil Size controls beside their separate artwork sections. Eye Convergence (Gaze) appears with the per-Goon **Eye Contact** controls; displayed `0°` applies the package's calibrated `4°` inward neutral. The five fitted-Sclera geometry controls remain under **Face Appearance -> Eyes -> Sclera Fit**. Reset returns these controls to the package's calibrated automatic eye fit. Sclera Fit is an expert correction surface: its wide endpoints may intentionally produce an unrealistic result so unusually large or tilted eye shapes can still be corrected. Sclera color, wrapped PNG artwork, opacity, and artwork rotation remain under the Sclera artwork section and do not move the physical eye geometry.

Save Goon stores both version-bound recipes and the exact upload hashes. Replacing the Goon package keeps them only when the new package declares compatible Facial Artwork and Eye Appearance definitions. Validation failures and incompatible resets are shown instead of silently applying approximate artwork or fit values. If an older Goon embeds a retired Facial Artwork package, the Goon itself and its package-update controls remain available while Facial Artwork and Eye Appearance show an update-required notice; install and save the current package to reset that incompatible artwork/fit state cleanly.

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
- one continuous Goon-centered scroll range, from close facial framing through normal dolly to wide exterior views; zooming in over the Goon targets that body area, while empty-space zoom and every zoom-out stay centered through full-body, upper-body, and face framing
- **Indoor Camera**, which keeps the camera inside the room, and **Free Camera**, which allows cinematic views from outside the building
- viewport controls: left-drag orbits, right-drag rotates the Goon, middle-drag moves the Goon across the room while keeping the currently viewed face/body area centered, and left+right drag pans the camera without moving the Goon or changing zoom
- Headshot, Portrait, and Full Body framing presets inside the FOV menu
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

- VRMA animations in the shared Motion Vault (used by VRM/VRoid Goons)
- GLB animations in the shared Motion Vault (used by Advanced/GLB Goons — clip tracks must target the Goon's skeleton bone names)
- Goon-specific animation files
- FBX uploads converted to VRMA when the converter is available

Native/local installs use the Admin-managed FBX2glTF installer for FBX conversion. Docker installs use the optional `fbx2vrma` worker profile:

```sh
docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker
```

Each Goon type automatically uses only its own format from the shared vault: VRM Goons play VRMA entries, and Advanced/GLB Goons play GLB entries. VRMA is the recommended default for VRM Goons because the VRM standard retargets it across avatars; GLB animation clips play by direct bone-name matching, so they need to be authored or retargeted for the Goon's specific rig.

You never manage two parallel libraries, though. The Settings → Goons → Motions tab shows **one card per motion**: when a VRMA file and a GLB file share the same base file name, they appear as a single motion with both `VRMA` and `GLB` badges. The name, tags, posture, playback, and eye-contact settings are shared between the two versions — edit them once and both formats stay in sync. Uploading the second format of an existing motion automatically picks up the settings you already gave the first one. If you upload a format the motion already has, Batshit asks before replacing it — replacing swaps the animation file but keeps the motion's settings, or you can skip and rename your file first to keep both. Either way you never end up with duplicate cards. The trash button removes the whole motion (all formats); the `(i)` menu on the card lists each version's source file and lets you remove just one format.

Previews are format-aware. VRMA motions preview on the built-in placeholder avatar, and GLB motions preview on a built-in purple Batshit dummy that uses the first-party Goon skeleton — so GLB previews work even before you create any Goons. If your GLB motions were made for a different skeleton, use the **GLB Preview Body** picker at the top of the Motions tab to preview them on one of your own Advanced/GLB Goons instead. Cards with both formats get a small `VRMA`/`GLB` toggle (under the thumbnail and on the live preview pane) so you can check that each version animates correctly.

Cues reference motions by name, so a paired motion works on every Goon automatically: a mood or emote pointing at that motion plays the VRMA version on VRM Goons and the GLB version on Advanced/GLB Goons.

## Default Goon Pack

The launch default Goon Pack is an optional import, not a bundled app asset. This keeps the Mac app and Docker image smaller while still giving you a ready-made starter set.

[Download the default Goon Pack](https://batshit.ai/downloads/goons/batshit-goon-default-pack.zip), then import it from Settings → Goons → Kitchen → Import Pack.

The pack includes moods, emotes, emoji triggers, custom Stage Postures, and Motion Vault files. Motions export in every format they have — a motion with both VRMA and GLB versions ships both, so imported cues work on VRM and Advanced/GLB Goons alike. It does not include Scenes.

## Closet and Wardrobe

Batshit separates global clothing from per-Goon clothing state:

- **Global Closet** — shared `.xwear` item library.
- **Wardrobe** — per-Goon clothing assignments, edits, conceal painting, and saved outfits.

Advanced/Blender original outfit pieces can appear as Wardrobe rows when the package manifest defines them. Built-in `All Original` and `None` are runtime/editor actions, not saved outfit records. `Save Current Outfit`, `Update`, and `Delete` on named outfits save immediately. Conceal painting is authored inside Batshit Live Preview, not in the Blender addon.

## Scenes

Goon scenes can use skyboxes, Room Builder surfaces, Ground Level or Elevated placement, uploaded room shells, props, posture markers, room textures, and one saved Scene Atmosphere layer. Scene placement is scene-wide: build scenes as either all-around Ground Level or all-around Elevated / Overlook, not half-ground and half-overlook. Procedural rooms automatically support Indoor Camera. For an Uploaded GLB room, open **Indoor Camera Boundary**, choose **Fit to Room**, and adjust the saved box if the model also contains exterior architecture or scenery. Large or high-poly scene assets can hurt performance — take the UI guardrails seriously.

Inside Scene Editor, the level-one order is **World**, **Room Builder**, **Props**, **Markers**. World contains Skybox upload/preview, Scene Placement, Ground Projection Line, and Scene Atmosphere. Room Builder contains Room Shell upload/replace/remove, the Uploaded GLB versus Procedural Builder choice, room textures, dimensions, and surfaces. Scene Placement is independent from the room choice, so switching between Ground Level and Elevated / Overlook does not replace an uploaded room shell. Prefer a self-contained `.glb` for uploaded Room Shells; a lone `.gltf` can reference external buffers or textures that are not included in a one-file upload.

For **Ground Level**, `50%` is the normal Ground Projection Line: Batshit treats that source-image row as the equirectangular equator and projects everything below it as ground. You can move the saved line from 25%-75% to correct an existing panorama with a globally high or low horizon. It cannot repair a TV, couch, wall, tree, rock, or other upright object already painted into the projected region. Ground Level skyboxes therefore work best when the entire lower region is continuous floor, grass, dirt, sand, terrain, or water. Use Room Builder, a Room Shell, or Props for nearby structure; use Elevated / Overlook when an indoor or furnished panorama should remain unprojected.

In **Uploaded GLB** mode, Room Shell Placement provides uniform scale, X/Y/Z offset, Y rotation, and Reset Placement. **Align Floor** probes for a walkable surface near the Goon and moves it to stage height. Generated models vary, so if Batshit cannot find the intended floor, it tells you clearly and leaves Y Offset available for manual alignment. These controls move the room only; separate Props and Markers do not move with it.

`Outside` atmosphere is physically outside the Room Builder volume, so opaque walls hide it. Use an open or transparent surface for visible exterior weather, or choose `Inside` / `Whole Stage` for motion within a closed room.

The Scenes list stays lightweight until you open a scene. Inside the Scene Editor, Batshit uses a simple standing/sitting proxy body by default for room and prop scale checks. Use the Active Goon preview when you need to check final fit against the real Goon, test a lying/tagged Motion, place posture markers, or judge Scene Atmosphere against the real avatar.

For assisted scene planning, enable the built-in **Goon Scene Creator** skill (`/goon-scene-creator`). Hero 8K is the recommended final skybox for best scene quality; use Standard 4K on smaller or lower-memory Macs/PCs, unusually heavy scenes, or when performance testing shows 8K is too costly. In the embedded Mac app, Ultra can use an 8K skybox when the graphics device supports it; Auto/High use up to 4K and Low uses up to 2K. These skybox limits are separate from avatar and room texture limits. The skill can then produce prompts, texture notes, Room Builder plans, one coherent Ground Level or Elevated placement, Scene Atmosphere choices, prop lists, and sit/lay marker guidance.

If you prefer to use an outside coding agent for scene planning, use the **Portable Goon Scene Creator** with a Portable Skill Token scoped to `Goon Scenes`. The portable version includes the same scene references and Qwen 360 ComfyUI workflow assets, but it does not directly save Goon scene records yet; it hands you Scene Editor steps unless future Goons/Scenes Fabric controls are available.

For local ComfyUI skybox generation, Batshit also ships workflow definitions for the proved Qwen 360 skybox lane inside the Goon Scene Creator skill bundle. The workflow files do not include model weights, LoRAs, VAEs, or upscalers; install those in ComfyUI separately. To copy the visible workflow into a ComfyUI user workflow folder from a source checkout, run:

```sh
node tools/comfyui/install-goon-scene-skybox-workflow.mjs
```

If your ComfyUI install is not in a standard location, pass the workflow folder with `--target`.

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
