# Skybox Generation

Use this reference when creating, prompting, or reviewing Batshit Goon scene skyboxes.

## Required Format

Batshit skyboxes should be:

- 2:1 aspect ratio;
- equirectangular panorama;
- horizontally seamless;
- centered horizon at exactly 50% image height for Ground Level assets;
- free of readable text, watermarks, logos, and obvious franchise marks;
- projection-safe lower hemisphere for Ground Level assets: continuous ground/floor only, with no nearby upright geometry painted into that region.

## Scene Placement Coherence

Generate the skybox for one scene-wide placement mode:

- **Ground Level:** the whole panorama should read as terrain/ground around the room. The equirectangular equator is exactly the 50% image row, and the entire lower region contains only continuous projectable ground/floor/terrain/water plus ground-baked shadows or reflections.
- **Elevated / Overlook:** the whole panorama should read as an elevated/open view, such as a rooftop, balcony, cliff, ship, space, or city overlook.

Do **not** create half-ground / half-overlook panoramas right now. Batshit does not yet have transition masks or real edge geometry that can cleanly cut the grounded projection around pillars, cliffs, rails, columns, walls, or other irregular scene objects. If a concept needs that kind of directional edge, redesign it as one coherent Ground Level scene or one coherent Elevated / Overlook scene.

Ground Level deformation applies to every source pixel below the selected Ground Projection Line. Nearby upright objects normally extend below an eye-level horizon in ordinary perspective, so furnished indoor panoramas, nearby trees/rocks, walls, televisions, sofas, and columns are poor grounded-skybox content. Build nearby structure with Room Builder, an Uploaded GLB Room Shell, or Props. Use Elevated / Overlook when an indoor or furnished panorama must remain unprojected.

Batshit's saved Ground Projection Line defaults to `50%` and can correct a globally high or low horizon in an existing panorama. It is not a semantic mask: moving it cannot repair upright objects already mixed into the ground region.

## Resolution Modes

| Mode | Final size | Use |
|---|---:|---|
| Draft | 2048x1024 | Prompt iteration or weak machines. |
| Standard | 4096x2048 | Smaller/lower-memory Macs or PCs, heavy scenes, or performance fallback. |
| Hero | 8192x4096 | Recommended final export for best scene quality. |

Hero 8K is the recommended final skybox and usually lands around 30-35 MB. Standard 4K usually lands around 10-12 MB and is the compatibility choice for smaller or lower-memory Macs/PCs, unusually heavy scenes, many mounted skyboxes, or machines that show performance trouble at 8K.

## Detail Prompt Baseline

Use these terms in the positive prompt, even when the final output is 4K:

```txt
Ultra high detailed, 8K texture detail, crisp high-frequency micro-detail, sharp fine surface detail
```

Then include panorama constraints:

```txt
true 360 degree equirectangular panorama, 2:1 aspect ratio, seamless horizontal wrap, centered eye-level horizon, room builder skybox background, projection-safe panorama
```

For Ground Level, add this exact contract:

```txt
Ground-projection-safe panorama, exact equirectangular equator at 50% image height, entire lower hemisphere contains only continuous ground, floor, terrain, grass, dirt, sand, or water extending from the camera into the distance, all nearby upright and vertical objects remain out of the lower hemisphere, no close foreground furniture or architecture
```

Useful **Ground Level** negative prompt terms:

```txt
text, captions, labels, logo, watermark, signature, people, characters, cropped view, fisheye lens, broken panorama seam, duplicate horizon, warped floor, blurry low detail, smeared texture, low resolution, upright objects below the equator, vertical forms in the lower hemisphere, furniture below the equator, walls crossing the equator, television below the equator, trees or rocks below the equator, close foreground architecture, broken ground band, multiple horizons
```

Only include `people` or `characters` as negative terms when the skybox should be environment-only. If the user explicitly wants silhouettes or crowds in the far distance, adapt carefully and keep them non-identifying.

## Proven Upscale Order

Upscaling should be the last image-processing step.

If a workflow generates a base panorama and then converts or projects it into a 360/equirectangular image, do the conversion first and upscale afterward. Do not upscale a non-panorama image and then expect the conversion step to preserve crisp final detail.

The proven high-quality path on Corey's RTX 4090 was:

1. Generate a 2048x1024 2:1 equirectangular base.
2. Upscale with RealESRGAN x2plus to 4096x2048.
3. Upscale again with RealESRGAN x2plus to 8192x4096 for Hero 8K.

For Standard 4K, stop after the first x2 upscale. For Hero 8K, run the second x2 upscale and expect a larger file plus more runtime/memory cost.

## Bundled Qwen 360 Workflow

Batshit ships workflow definitions for the proved local Qwen 360 lane in:

```txt
assets/comfyui/
```

Use `references/qwen360-skybox-workflow.md` before installing, running, or troubleshooting that workflow. It describes the API template, the visible ComfyUI workflow JSON, required model filenames, required node classes, output modes, and the helper script for copying the visible workflow into ComfyUI's user workflow folder.

The repo ships workflow definitions only. It does not bundle the Qwen model files, the Qwen 360 LoRA, the VAE, or RealESRGAN weights.

## Hardware-Aware Decision

Ask or infer the target:

- If the target is unknown: recommend Hero 8K as the final output.
- If the user has a smaller or lower-memory Mac/PC, a texture-heavy scene, many mounted skyboxes, or performance trouble: choose Standard 4K.
- If the user is generating many variants: iterate in Draft or Standard first, then upscale only the chosen final.
- If the user's machine handles the scene comfortably: keep the recommended Hero 8K final.

Never silently downgrade from requested 8K to 4K. If generation fails, say what failed and provide the next practical option.

## Review Checklist

Before calling a skybox ready, verify:

- final dimensions match the chosen mode;
- aspect ratio is exactly 2:1;
- no hard seam at the left/right edge;
- no obvious readable text, logo, or watermark;
- the horizon does not tilt unless requested;
- the style is original and not a direct copy of a reference image;
- an exact 50% horizontal guide confirms the Ground Level lower region contains projectable ground/floor only;
- no nearby raised object crosses below the selected Ground Projection Line;
- the panorama still reads correctly in a 360 viewer and in Batshit Ground Level mode;
- file size is acceptable for the target scene.

## Ground Level Prompt Template

```txt
[scene concept], true 360 degree equirectangular panorama, exact 2:1 aspect ratio, seamless horizontal wrap, Ground-projection-safe panorama, exact equirectangular equator at 50% image height, entire lower hemisphere contains only continuous ground, floor, terrain, grass, dirt, sand, or water extending from the camera into the distance, all nearby upright and vertical objects remain out of the lower hemisphere, no close foreground furniture or architecture, Ultra high detailed, 8K texture detail, crisp high-frequency micro-detail, sharp fine surface detail, realistic material texture, coherent depth, soft cinematic lighting
```

Negative:

```txt
text, captions, labels, logo, watermark, signature, cropped view, fisheye lens, broken panorama seam, duplicate horizon, warped floor, blurry low detail, smeared texture, low resolution, upright objects below the equator, vertical forms in the lower hemisphere, furniture or walls below the equator, television below the equator, trees or rocks below the equator, close foreground objects, broken ground band, multiple horizons
```

## Elevated / Overlook Prompt Template

```txt
[scene concept], true 360 degree equirectangular panorama, exact 2:1 aspect ratio, seamless horizontal wrap, elevated open panorama, lower view remains distant world rather than projectable ground, Ultra high detailed, 8K texture detail, crisp high-frequency micro-detail, sharp fine surface detail, realistic material texture, coherent depth, soft cinematic lighting
```

Negative:

```txt
text, captions, labels, logo, watermark, signature, cropped view, fisheye lens, broken panorama seam, duplicate horizon, warped architecture, blurry low detail, smeared texture, low resolution, close foreground floor, nearby ground filling the lower hemisphere, enclosed ground-level room
```

Do not carry the Ground Level equator/lower-ground negatives into an Elevated / Overlook prompt. The modes intentionally ask for different lower-hemisphere composition.
