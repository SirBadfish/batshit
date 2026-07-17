# Batshit Goon Scene Spec

This reference summarizes the current Batshit scene model for Goon scenes.

## Current Scene Model

A saved scene is shaped around:

- `id`
- `name`
- optional `description`
- optional `skybox`
- optional `scenePlacement`
- optional `groundProjectionLine`
- optional uploaded `roomShell`
- optional `roomShellTransform`
- optional `roomShellBuilder`
- optional `props`
- optional `markers`
- optional `ambience`

Current TypeScript source: `GoonSceneDefinition` in `batshit-app/src/lib/types/goons.ts`.

## Scene Parts

| Part | Current meaning |
|---|---|
| Skybox | A 360 equirectangular background, normally 2:1 aspect ratio. Use this for atmosphere and distant world context. |
| Scene Placement | A scene-wide `ground` or `elevated` choice controlling grounded-skybox projection independently from the room source. |
| Ground Projection Line | Saved source-image row used as Ground Level's projection boundary. Default `0.5` (50%); bounded to 25%-75%. |
| Room Shell | An uploaded 3D room shell. Saved placement supports uniform scale, X/Y/Z offset, and Y rotation. |
| Room Builder | Batshit's procedural room shell: floor, ceiling, north/south/east/west walls, textures, trim textures, tile/stretch fit, cutout/glass/opaque transparency, and floor offset. |
| Props | Static GLB/GLTF scene objects with position, rotation, and scale. |
| Markers | Explicit stage placement anchors for sit and lay behavior. |
| Scene Atmosphere | One lightweight built-in particle layer saved with the scene. |

Standing does not use explicit stand markers. Batshit places standing Goons on the floor.

## Room Builder Notes

Room Builder is the preferred path for generated scenes because it gives Batshit a predictable 3D room while the skybox supplies the broader world.

Plan these surfaces:

- floor;
- ceiling, if the room should feel enclosed;
- north, south, east, and west walls;
- interior texture for each enabled surface;
- exterior texture when cutouts, balconies, windows, or transparent walls expose the outside;

Scene Editor level-one order is **World**, **Room Builder**, **Props**, **Markers**. World owns Skybox, Scene Placement, Ground Projection Line, and Scene Atmosphere. Room Builder owns Room Shell upload/replace/remove, Uploaded GLB versus Procedural Builder selection, Room Shell Placement/Align Floor, textures, dimensions, and surfaces.

Uploaded GLB mode exposes **Room Shell Placement**: uniform scale, X/Y/Z offset, Y rotation, Reset Placement, and best-effort Align Floor. Align Floor probes for a walkable surface near the Goon instead of aligning the model's lowest bounding-box point. Generated GLBs are inconsistent, so a failed probe must stay visible and manual Y Offset remains the fallback. These controls move only the room shell, not Props, Markers, the Goon, or the skybox.

Use tiled textures for material surfaces like wood, carpet, stone, wallpaper, and tile. Use stretch only for image-like murals or surfaces where tiling would reveal repetition.

## Scene Placement Notes

Scene placement decides whether Batshit ground-projects the skybox below the room.

- Use **Ground Level** for meadow, forest floor, garden, beach, courtyard, ruin, patio, cabin, and other one-story/terrain scenes.
- Use **Elevated / Overlook** for high-rise, balcony, rooftop, cliff, ship, space, floating, city-view, and distant-overlook scenes.
- Ground Level targets an exact equirectangular equator at `50%` image height. The entire region below the selected Ground Projection Line must contain projectable floor/terrain/water only; nearby furniture, walls, screens, trees, rocks, buildings, columns, and other upright geometry must not cross into it.
- Elevated / Overlook works best when the bottom of the skybox should remain open view rather than becoming floor.
- Do **not** design split-placement scenes where part of the panorama expects Ground Level projection and another part expects Elevated / Overlook rendering. Batshit currently treats placement as one scene-wide authoring decision.
- If the concept includes an overlook in only one direction, simplify it to a fully Elevated / Overlook scene, or redesign it as a fully Ground Level scene with real Room Builder surfaces/props implying the edge. Do not rely on the skybox projection to cut around pillars, cliffs, rails, columns, or irregular transition objects.

Saved placement uses top-level `scenePlacement: "ground" | "elevated"`. It works with either an Uploaded GLB room shell or the Procedural Builder and must not switch room modes when changed. Existing scenes may still be read through Batshit's centralized fallback for the earlier `roomShellBuilder.terrainSkirt` ground signal.

Saved `groundProjectionLine` is measured from the top of the source panorama. Missing values normalize to `0.5`; the Scene Editor allows 25%-75% and Reset returns to 50%. It remaps which panorama row feeds the grounded sphere equator without tilting the ground geometry. It can correct a globally high/low existing horizon, but cannot reconstruct upright content already painted into the projected region. Furnished indoor panoramas are normally better as Elevated / Overlook backgrounds or replaced by real room/prop geometry.

## Scene Atmosphere Notes

Scene Atmosphere is a single saved particle layer, not a general animation system. Current built-in presets are:

- rain;
- snow;
- embers;
- fireflies;
- dust/pollen;
- petals;
- magic sparks;
- mist.

`Outside` places particles beyond the Room Builder volume, so opaque walls naturally hide them. Use open/transparent surfaces for visible exterior weather, or choose `Inside` / `Whole Stage` for a closed room.

Choose one placement:

- **Inside** for room-local effects such as dust, embers, magic sparks, or fireflies.
- **Outside** for weather or exterior-only motion such as rain, snow, petals, or mist outside the room.
- **Whole Stage** for subtle all-around motion when the scene is open or when the effect should surround the Goon.

The saved data supports `enabled`, `preset`, `placement`, `intensity`, `speed`, and `wind`. The first pass uses built-in particles only. Do not promise custom particle sprites, multiple ambience layers, weather occlusion, or particle collision.

## Props

Props are static today. Use them for:

- furniture;
- lamps;
- shelves;
- plants;
- small set dressing;
- background objects that need real 3D parallax.

Do not promise animated prop playback, physics, prop-owned particle systems, or video-textured props as current behavior. Use Scene Atmosphere for the one supported lightweight particle layer.

## Markers

Markers should be sparse and intentional.

| Marker type | Use |
|---|---|
| Sit | Chairs, benches, bed edges, cushions, floor pillows, stools. |
| Lay | Beds, couches, mats, floor pads, lounge spots. |

Name markers by purpose, such as `desk-chair-sit`, `window-seat-sit`, or `bed-lay`.

## Pack and Asset Truth

Goon Kitchen pack sharing can include scenes, scene skyboxes, room shells, Room Shell Placement, Ground Projection Line, Room Builder textures, props, markers, Scene Atmosphere settings, moods, emotes, and Motion Vault items depending on the export selection. Imported scene name collisions keep both items by renaming the imported copy.

The launch default Goon Pack does not include scenes.

## Performance Guidance

Large scene assets can hurt performance. Prefer:

- one skybox over many distant props;
- Room Builder surfaces over heavy room meshes;
- a small prop list with useful silhouettes;
- one subtle Scene Atmosphere layer instead of heavy animated props;
- compressed, reasonably sized texture files;
- Hero 8K skyboxes as the recommended final-quality path;
- Standard 4K skyboxes for smaller/lower-memory Macs or PCs, heavy scenes, or performance trouble.

Fail clearly when assets are missing or too heavy. Do not silently substitute different visuals.

## Not Current

These are not current saved-scene features:

- custom ambience sprites or multiple ambience layers;
- animated props;
- GIF or video textures;
- multi-Goon stage presentation;
- physics or collision authoring;
- automatic room generation from a skybox alone.

You may suggest these as future polish ideas, but keep the scene plan grounded in the current product.
