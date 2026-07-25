# 3D Goons and advanced packages

3D Goons are expressive avatars for Batshit agents — they sit in the Goon Dock, react to chat cues, move with animations, wear saved outfits, and lip sync while an agent speaks. Giving your AI an actual face that emotes in 3D isn't something you'll find in other chat apps; it's one of Batshit's signature toys.

Batshit has three supported Goon paths with deliberately different authoring effort: Standard/VRoid is simplest, supported first-party Advanced/GLB is a close second with the richest automatic Batshit-owned workflow, and Advanced/Blender Custom VRM is the expert path for existing Blender characters.

## Supported Goon types

| User-facing type | What you import | Current support |
| --- | --- | --- |
| Standard/VRoid Goon | A `.vrm` file | Simplest path; direct import with the avatar's real VRM capabilities. |
| Advanced/GLB Goon | A package containing `avatar.glb` and `avatar.json` | Nearly-as-simple for supported first-party packages: automatic preparation, rich appearance/face contracts, and rig-matched GLB Motions. Arbitrary GLBs remain expert packages. |
| Advanced/Blender Goon | A `.bgoon` or `.zip` package containing `avatar.vrm` and `avatar.json` | Most advanced first-class path. Uses Blender/VRM plus Batshit manifest metadata and may require exact shape-key mapping, anchors, validation fixes, and re-export. |

Standard/VRoid and Advanced/Blender use the VRM 1.0 runtime. Advanced/GLB uses its own strict manifest-bound runtime. Arbitrary humanoid models aren't guaranteed to work in either package lane.

## Create a Standard/VRoid Goon

1. Open Settings → Goons.
2. Choose Create New Goon (Standard VRM / VRoid).
3. Upload a `.vrm` file.
4. Give it a clear name.
5. Save it.
6. Assign it to an agent in Agent settings.
7. Open the Goon Dock from the right sidebar.
8. Send a short message with TTS enabled if you want to test lip sync.

If the avatar loads but some expressions don't work, the VRM may be missing those blendshapes or bones. Happy, Relaxed, Sad, Angry, and Surprised still appear in the Mood/Emote editor, but unsupported presets are disabled and labeled **Unavailable** for that model rather than hidden or presented as working. **Reset Face** always returns the Goon to the model's authored Neutral resting face instead of depending on a separate blendshape.

Starter Goons are offered as a download card, not bundled inside the app. When you choose one, Batshit downloads the allowlisted hosted VRM once and saves it through the same upload path as your own `.vrm` file.

## Create an Advanced/Blender Goon

Advanced/Blender Goons use a package, not a loose model file. The package must include:

- `avatar.vrm`
- `avatar.json`

The manifest can include stage anchors, face expression mappings, face control mappings, custom morphs, original outfit piece metadata, and spring bone metadata from the VRM export. Simple expression mappings drive every listed target at the chosen semantic intensity. Expert/first-party packages may instead use the versioned `batshit-expression-recipe/v1` form to give each mapped target a separate adapter weight greater than `0` and no greater than `1`; Batshit rejects empty recipes, duplicate targets, invalid weights, and mappings whose targets do not all exist in the exported model.

1. Prepare the character in Blender.
2. Validate and export the package with a compatible Advanced/Blender authoring workflow.
3. Open Settings → Goons.
4. Choose Create New Goon (Advanced/Blender).
5. Upload the `.bgoon` or `.zip` package.
6. Save the Goon.
7. Open the Goon Editor to check Custom Goon Builder, Wardrobe, Moods, Emotes, Eye Contact, and camera framing.
8. Assign the Goon to an agent.
9. Test in the Goon Dock.

Advanced/Blender packages and high-detail VRM files can be large. Batshit supports core Goon imports up to `600M`; Docker keeps a broader `BODY_SIZE_LIMIT=1G` app front-door limit for Admin restores and other trusted local imports, but batshit-server still applies the Goon-specific cap after the request reaches the upload service.

First-party Advanced/GLB packages can include versioned shape controls under one **Custom Goon Builder**. Face work comes first: Brows, Eyes, Nose, Mouth & Lips, Cheeks, Chin & Jaw, Ears, and package-fitted artwork. Body work follows: Stature, Head, Neck, Hands & Feet, Arms, Legs, Waist, Chest, Hips, Butt, and Advanced. Head and forehead-shape controls stay with the body silhouette; Forehead Tighten and Brow Angle are under Brows, while Face Fullness is under Cheeks. Saved values live with the Goon and update the open Goon Dock without a browser or app reload. Current first-party socket-eye packages keep **Eye Corner Smoothing**, linked **Iris Size**, iris-relative **Pupil Size**, and linked **Iris Vertical Position** under Custom Goon Builder → Face → Eyes. Iris Vertical Position moves Iris, Pupil, and Highlight together without shifting gaze-linked Sclera artwork. They do not expose Sclera Fit: the fitted sclera is one fixed socket-conformal surface. Eye Contact projects one world target independently into each eye for automatic depth-aware convergence and exposes **Enabled**, **Strength**, **Head Follow**, **Response**, and a small centered **Gaze Convergence** fine-tune. Batshit validates the package's exact morph, follower, joint, cap/liner, and dynamic-face ownership before enabling the controls; malformed packages fail clearly instead of loading a partial identity system. Standard/VRoid and Advanced/Blender Goons keep their own existing eye behavior.

The appearance search boxes cover their complete Face or Body catalog, including nested Brow Artwork, Eye Artwork, Eye Corner Smoothing, and Oral Appearance controls. Regional reset buttons restore only that region; **Reset Dials** restores every changed control in the current Face or Body section to the package-authored defaults.

Appearance values are bound to the exact package definition and neutral meaning. A package update keeps them only when Batshit proves the exact old-to-new relationship. If preservation is not proven, Batshit either offers an explicit safe reset or blocks the update; it never guesses or silently reinterprets old values.

## Advanced/GLB preparation and updates

For a supported first-party Advanced/GLB Goon, the normal flow is simply **upload, edit, and Save Goon**.

### Create and edit

1. Choose Create New Goon (Advanced/GLB) and upload the supported `.bgoon` package.
2. Batshit shows **Preparing** while it checks and prepares the first runtime version automatically. There is no bake choice.
3. The Goon becomes **Ready** only after that version verifies. Until then, it cannot be assigned to an agent or opened in the Dock.
4. Make as many face and body edits inside **Custom Goon Builder** as you want.
5. Click **Save Goon** once. Batshit combines that saved appearance batch into one checked update.

Mood, Emote, Motion, camera, Eye Contact behavior, voice, and ordinary runtime-only wardrobe/settings changes do not rebuild the Goon. If a later appearance update fails, the previously working Goon stays active. A failed first preparation remains clearly marked and offers Retry/Discard recovery instead of looking ready.

Facial Emotes can keep two versions of the same performance: a portable Standard/VRoid face recipe and an ARKit-52 recipe for supported Advanced/GLB Goons. Batshit uses exactly one version for the loaded Goon; it never stacks the two faces. Existing Emotes keep their Standard/VRoid performance but start neutral on ARKit-52 Goons until you author the ARKit controls. When an Emote deliberately moves the eyes, that authored direction temporarily takes priority over Eye Contact.

Ordinary progress uses **Preparing**, **Checking**, and **Applying**. Expand **Technical Details** only when you need exact internal stages, package identities, revision ids, hashes, or proof evidence for support.

### Update the Goon file

Choose **Update Goon File** and select the newer supported `.bgoon`. Batshit checks the exact old and new package identities before it offers an action:

- **Update Goon** means the saved appearance is proven safe to keep, including an exact exporter-supplied conversion when required.
- **Keep Current** abandons the proposed file and leaves the current Goon unchanged.
- **Reset Appearance and Update** appears only when preservation cannot be proved but a clean neutral reset is independently verified as safe. Batshit never resets appearance silently.
- A blocked/ineligible file cannot replace the current Goon. The error explains the missing identity, provenance, mapping, or structural support.

The Current and Updated previews share the same camera, pose, lighting, animation time, and expression. Technical Details can show each kept, converted, new, removed, reset, or blocked control. If unsaved appearance edits exist when you choose a file, Batshit asks whether to save them first, discard them first, or cancel.

Every update builds and verifies a candidate before activation. The current Goon remains usable until the candidate commits successfully. Retry resumes verified stored work; Discard removes only unreferenced pending work.

### Restore the previous version

**Restore Previous Version** asks for confirmation before swapping the complete prior version back. Its package, appearance values, Facial Artwork, Eye Appearance, Oral Appearance, Lip Artwork, runtime model, manifest, and other version-owned state move together. The version you leave becomes the previous version, so the restore can be reversed.

### Blender-author compatibility for first-party Advanced/GLB files

The first supported author-update contract is **first-party-only**. Authors edit through Batshit's supported Blender/export workflow, export a complete `.bgoon`, and users install it with **Update Goon File**. A loose GLB, hand-patched archive, matching name, or visually similar model is not considered compatible. Independently authored Advanced/GLB update packages are not supported by this contract yet.

Each exact update lands in one class:

| Result | What Batshit proved |
| --- | --- |
| Automatic appearance-preserving | The exact physical and semantic result of the saved appearance is unchanged. |
| Proven remap | The exporter supplied a direct edge and exact map, and Batshit independently reproduced and verified the complete result. |
| Reset required | Preservation is not proven, but an exact neutral reset is safe and the user explicitly confirms it. |
| Blocked/ineligible | Required scope, identity, provenance, structure, mapping, or proof is absent, unknown, ambiguous, invalid, or tampered. |

The compatibility checks cover presentation metadata; textures and materials; equivalent GLB storage/layout; base neutral and geometry; topology and vertex order/count; mesh/node identities; morph inventory and stable control ids; targets, followers, macros, ranges, and neutral meaning; skeleton hierarchy and bone identities; rests, inverse binds, and weights; root/grounding; stage roles and attachments; fit consumers; runtime correctives and performance mappings; Eye definitions; Facial Artwork roles; Lip Artwork; and oral definitions.

Technically, a supported export must provide exact `recipe-source/v1` source identities and a `recipe-updates/v1` contract containing one direct old-to-new edge, an exhaustive stable control ledger, explicit sibling decisions, and exact proof hashes. Changed coupled behavior also requires the matching self-hashed component map. Batshit reloads the real package/model/manifest bytes and independently verifies the component map, complete physical result, semantic materials, sibling state, and clean-reset safety. Missing or unknown provenance fails clearly; Batshit never guesses compatibility from names or appearance.

Supported first-party Advanced/GLB packages can also include facial artwork inside **Custom Goon Builder → Face**. Open **Brows → Brow Artwork** for brows. Open **Eyes** for separate **Lash & Outline Artwork**, **Iris Artwork**, **Pupil Artwork**, **Eye Highlight Artwork**, and **Sclera Artwork** sections. Each artwork header keeps its description behind the adjacent info icon, and each section provides one exact **Template** for the active anatomical side. Clicking it opens Save As in the packaged Mac app or downloads it in a browser; it does not navigate away from the editor. Use the Template as a reference layer, paint on a separate transparent layer, then hide or remove the Template before exporting a single-frame, 8-bit PNG at its exact dimensions. Batshit never resizes Facial Artwork. During upload, Batshit converts the pixels to canonical sRGB/RGBA, removes embedded color-profile metadata, clips transparency to the package's trusted internal Mask, clears invisible fringe color, and losslessly re-encodes the stored PNG before validating package/template identity and source rights. This lets ordinary Photoshop and AI-generated PNGs work without requiring you to remove an ICC profile yourself.

The Lashes & Eye Outline Template is shaped like an open eye. Its dark gridded region provides full-perimeter room for the upper lid, lower lid, both corners, and outer wing; pink is forbidden. The faded eyebrow, nose/temple marks, labels, and grid make the anatomical side obvious but are instructions only. Use the explicitly labeled Goon Left Eye Template for canonical shared artwork, or download the Goon Right Eye Template when authoring a right-eye override. Batshit binds the upload to that exact Template and internal Mask orientation so it mirrors the texture exactly once and rejects or clips pixels outside the safe region.

Every artwork role supports **Same for both** or **Customize each eye**. Shared Brows and Lashes & Eye Outline mirror the artwork automatically; you can still supply different left/right art when the character is intentionally asymmetrical. With shared Brows, Horizontal Position moves both brows closer together or farther apart instead of sliding both toward the same side. The Brow template and physical regions extend all the way to the face center with no built-in gap, so artwork may form a true unibrow. The brow canvas also includes a restrained outer working band toward each temple; it preserves center-side artwork placement while giving Horizontal Position room to move the brow outward without wrapping the canvas around the head. For Brows, Lashes, Iris, Pupil, and Eye Highlight, moving **Vertical Position** to the right moves the artwork up; moving it left moves the artwork down. **Scale `1`** is the package-calibrated full-size neutral for each role, with room to make the artwork smaller or larger. Brow scale tops out at `1.4`. Iris and Pupil remain independent: each can use a solid color with no artwork and add optional artwork over that color. **Pupil Size** ranges from `0` to `2` and is relative to the current Iris Size, so changing Iris Size also carries the pupil with it; `0` hides the pupil and `1` keeps the neutral pupil-to-iris ratio. Eye Highlight applies one authored catchlight continuously across the combined iris and pupil, so one painted mark appears once. Sclera also has a solid base color plus optional wrapped artwork.

For artwork you made, choose **My artwork** or **Made by me with ComfyUI**. Batshit credits the display name from User Settings and treats pressing Upload as your confirmation that you may use your own work. If that display name is missing, Batshit tells you to add it instead of inventing a credit. Choose **External artwork I may use** for someone else's work; that path still requires the author/source, license or permission, and an explicit rights confirmation for every upload.

Supported first-party packages can also expose **Custom Goon Builder → Face → Mouth & Lips → Lip Artwork**. Download its exact **Template**: it is a centered front view shaped like a real pair of lips, with the cupid's bow, upper lip, lower lip, mouth seam, center guides, and an on-canvas legend. Keep that guide as a reference layer, paint on a separate transparent layer, then hide the guide and export a valid, non-empty, single-frame `2048×2048` PNG. Cyan is the package-authored base-lip reference, pale gray is additional safe room for extending or stylizing the edges, and pink is forbidden. You may cover as much or as little of the cyan reference as your design needs; Batshit handles the installed package proof automatically, converts supported PNG channel and bit-depth variants to its canonical 8-bit RGBA format, clips only the pixels outside the safe region, and rejects an entirely transparent result. Upload still requires the same author/source/license confirmation as other artwork. Uploaded color and transparency automatically use the package's real scene lighting and lip-surface finish, so even flat-color artwork remains dimensional without painted-in highlights. **Lip Color** changes the uploaded artwork's tint without changing its painted footprint, while **Opacity** fades the whole result. **Use Package Artwork** removes the custom upload and restores the package-authored lip art, color, and opacity. The artwork follows supported mouth Appearance controls as well as expressions and speech. Save Goon stores the exact upload and rebuilds the checked Live Goon; packages without a declared Lip Artwork surface do not show these controls.

The Face section keeps linked Iris Size, iris-relative Pupil Size, and Iris Vertical Position beside their separate artwork sections, plus Eye Corner Smoothing with the other package-authored face controls. Iris Vertical Position moves both irises together while each pupil and highlight stays centered in its iris; it does not change gaze. The first-party socket-conformal eye has no manual Sclera Fit. Its fixed cap follows identity, Blink, Wide, and Squint without rotating a globe. **Eye Contact** exposes Enabled, Strength, Gaze Convergence, Head Follow, and Response. Batshit projects the same world target separately into the left and right eye surfaces, so near/far convergence happens automatically; Gaze Convergence provides a small bounded inward/outward adjustment when perception needs it. Response smooths both eye travel and Head Follow in either direction, including the return to center. Camera gaze also drives the matching ARKit Look shapes, so eyelids and liner naturally follow Up, Down, In, and Out instead of leaving only the Iris/Pupil moving. Sclera color, wrapped PNG artwork, opacity, and artwork rotation remain under Sclera Artwork and do not move the physical eye geometry.

Supported first-party packages can also expose **Custom Goon Builder → Face → Mouth & Lips → Oral Appearance**. Teeth Color, Teeth Brightness, and Teeth Shine affect the shared upper/lower teeth material; Gum Color affects both gum arches; Tongue Color affects the tongue. These controls preserve the package-authored texture detail and do not alter facial identity, expressions, or speech shapes. Reset restores the exact package-authored colors and surface roughness. Oral Appearance v1 deliberately accepts no texture upload; custom teeth textures remain unavailable until they have a safe template and full validation/storage lifecycle.

Save Goon stores both version-bound recipes and the exact upload hashes. Replacing the Goon package keeps them only when the applicable package-update contract proves compatible Facial Artwork, Eye Appearance, Oral Appearance, and Lip Artwork definitions; current first-party Lip Artwork editing is supported within the same package, while cross-package Lip Artwork preservation awaits an explicit versioned update contract. Validation failures and incompatible resets are shown instead of silently applying approximate artwork or fit values. If an older Goon embeds a retired Facial Artwork package, the Goon itself and its package-update controls remain available while Facial Artwork and Eye Appearance show an update-required notice; install and save the current package to reset that incompatible artwork/fit state cleanly.

## Advanced/Blender authoring status

Batshit can import Advanced/Blender packages, but the first-party Batshit Blender addon isn't included in the public AGPL core snapshot. Its distribution and license are separate from the core app.

This is intentionally Batshit's expert Goon lane. It is appropriate for experienced Blender artists and for people willing to learn the specific preparation work their character needs. Batshit provides the supported workflow and documents exact requirements, but authors should expect to name or map blendshapes/shape keys, establish stage anchors, clear Stage Ready and Talk Ready validation, optionally clear Audio2Face Ready, and re-export after fixing blockers.

It can also support an independent creator ecosystem: artists may offer Batshit-ready original characters, commissioned work, conversion services, or models whose licenses explicitly allow the intended modification and redistribution. Technical compatibility is not an intellectual-property license. A purchased asset may allow only personal use, and an extracted game model generally does not become resellable merely because it was modified. Batshit does not distribute third-party game characters or certify a seller's rights. Before sharing or selling a package, verify the source license, commercial-use terms, redistribution permission, attribution requirements, and the rights holder's current policy.

When the addon is distributed, it's expected to wrap the Batshit-specific prep/export workflow:

- source snapshot before destructive prep
- mesh health checks
- shape-key freeze/rebase helpers
- rig cleanup guardrails
- Split Jobs for extraction or bake prep
- Kiln-aware bake prep and cleanup
- face slots for either the Rhubarb-9 or exact OVR-15 speech profile
- optional exact ARKit-52 mapping and Audio2Face Ready validation
- custom morph capture
- stage anchor mapping
- Advanced/Blender outfit metadata
- package validation
- `.bgoon` package export

That authoring workflow doesn't replace Blender, the VRM add-on, Auto-Rig Pro, or Kiln.

## Advanced authoring dependencies

Required for Advanced/Blender export:

- Blender 4.2 or newer; the current Batshit addon `0.3.0` is tested in Blender 5.1
- Batshit Blender addon `0.3.0` / manifest contract `3`
- VRM Add-on for Blender `4.4.0` or newer in its compatible Blender 4.2+ extension lane

Endorsed but not always required:

- Auto-Rig Pro for the highest-success Advanced/Blender humanoid authoring path
- Faceit 1.8 or 2.3 when an artist wants its ARKit creation/retargeting workflow; Faceit is an authoring aid, not a Batshit runtime dependency

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
7. Validate Stage Ready and Talk Ready. If this Goon should receive NVIDIA Audio2Face directly, also validate Audio2Face Ready.
8. Fix blockers.
9. Export the package.
10. Import the package into Batshit.

Don't continue past missing Blender dependencies or validation blockers. Bad packages should fail loudly instead of becoming mysterious runtime bugs.

## Stage Ready and Talk Ready

**Stage Ready** needs anchors that let Batshit place the character in scenes. The minimum anchor set includes head, upper chest, hips, and feet information.

**Talk Ready** needs usable face/mouth mappings so Batshit can drive speech and expressions. In the Batshit Blender addon, that means every channel in the selected Rhubarb-9 or OVR-15 speech profile plus blink. Switching profiles preserves the inactive profile's mappings, but only the selected profile is exported and validated. If a package isn't Talk Ready, it may still render, but mouth movement and expressive cues can be incomplete or unavailable.

**Audio2Face Ready** is optional and separate from Talk Ready. It requires all `52` canonical ARKit source channels to map explicitly to real shape keys on exported face meshes. Choose **Auto-Map Slots By Name** first: it recognizes canonical ARKit names regardless of letter case or separators, so `jawOpen`, `JawOpen`, and `JAW_OPEN` match the same source channel. Then map any remaining rows manually with **Use Active Key** or **Capture**.

Faceit does not impose one universal exported target-shape naming scheme: its target list can retarget each ARKit source expression to one or more arbitrary character shape keys. Batshit therefore treats name detection as a convenience, not proof. Partial or unresolved ARKit work stays saved in the `.blend`, but the addon omits `face.arkit52` from `avatar.json` until all 52 channels resolve to real shape keys on their mapped Export Meshes. A complete declaration maps one source channel to one or more targets, rejects a target shared by different source channels, and enables direct full-face Audio2Face playback. Batshit keeps its bone-driven gaze in charge of the eight eye-look channels because NVIDIA's current output leaves those values at zero.

After fixing any validation row, run **Validate** again, export a new `.bgoon`, and replace the Goon file in Batshit. If Audio2Face Ready is **No**, the package can still be Stage Ready and Talk Ready; it simply uses its selected Rhubarb-9 or OVR-15 speech mapping instead of claiming full ARKit support.

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
- NVIDIA Audio2Face for compatible first-party Advanced/GLB Goons

Realtime TTS uses live analyser/timing behavior; Rhubarb WASM and the first Audio2Face release need completed audio. Inworld realtime TTS can use provider-native phoneme/viseme timing live, while Fish realtime TTS uses streamed audio/text timing without provider mouth-shape details. Audio2Face needs Batshit's optional Docker bridge plus a separately installed and licensed NVIDIA Audio2Face-3D NIM v2.0 GPU runtime. If Audio2Face is unavailable, Batshit reports the failure and tries Rhubarb before text timing. If lip sync doesn't work, first prove TTS audio plays, then check the Goon's Rig Health and mouth blendshape support. If the mouth moves on time but the shapes look bad, tune the authored mouth morphs and face-expression mappings.

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

Moods can reference loop Motions by name, and agents can trigger one-shot Motions directly. A paired Motion works on every Goon automatically: Batshit plays the VRMA version on VRM Goons and the GLB version on Advanced/GLB Goons. Emotes are facial-only and never link to Motion files.

## Default Goon Pack

The default Goon Pack is an optional import, not a bundled app asset. This keeps the Mac app and Docker image smaller while still giving you a ready-made starter set.

[Download the default Goon Pack](https://batshit.ai/downloads/goons/batshit-goon-default-pack.zip), then import it from Settings → Goons → Kitchen → Import Pack.

The pack includes moods, facial Emotes, emoji triggers, custom Stage Postures, and Motion Vault files. Current format-v6 packs carry both the portable Standard/VRoid face recipe and the optional ARKit-52 face recipe for each cue; package-specific raw morph targets are never exported. Motions export in every format they have — a motion with both VRMA and GLB versions ships both, so imported Moods and direct Motion cues work on VRM and Advanced/GLB Goons alike. Current exports never attach a Motion to an Emote. When an older pack contains a motion-linked Emote, Batshit imports its animation as a standalone Motion and keeps only any authored facial part as the Emote. It does not include Scenes.

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

## Current boundaries

- VRM 1.0 is the primary runtime.
- Advanced/GLB plays rig-matched GLB Motions, but automatic retargeting and outfit parity are not available.
- Arbitrary models aren't guaranteed to become compatible Goons.
- Facial control is blendshape-based.
- Animation retargeting isn't automatic.
- XWear overrides are material-focused; the target material must exist in the VRM export.
- Skyboxes are equirectangular in v1.

## Related docs

- [Voice](../voice/overview.md)
- [3D Goons overview](overview.md)
- [Voice, TTS, and STT](../voice/voice-settings.md)
