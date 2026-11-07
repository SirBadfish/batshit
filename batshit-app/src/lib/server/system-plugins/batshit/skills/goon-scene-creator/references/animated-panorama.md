# Animated exterior panoramas

Read only when the user wants a video background, an animated skybox, or help troubleshooting one. Still-only scene planning does not need this guide. If starting from a perspective hero image, first use `image-first-panorama.md`.

## Intent and current import contract

An animated panorama adds atmosphere outside a separately built stage: the city is alive while the camera and architecture stay fixed. Rooms can be floor-only, patios, partial shells, glass walls, canopies, or full rooms with large windows. Do not bake the user's room into the backdrop.

In Scene Editor -> World -> Skybox, select a PNG/JPG image or MP4/WebM video. Videos loop silently. Saved scenes retain the original video plus a separate still thumbnail. Scene packs carry the original media; importing it generates a fresh thumbnail. Video upload limits are 250 MB, 8192×4096 maximum, 2:1 aspect ratio, two minutes, and 60 fps. Typical atmospheric loops are much shorter: 12 seconds at 24 fps worked well in the verified city.

The server accepts H.264/HEVC/AV1 in MP4 and VP8/VP9/AV1 in WebM, validates metadata and decodes a thumbnail through FFprobe/FFmpeg. Playback depends on the browser/device's actual decoder. A 4K H.264 MP4 is a useful compatibility delivery; an 8K AV1 MP4 was verified on the RTX 4090 Windows browser. Do not promise the same 8K codec on every Mac or phone. Video remains at its uploaded resolution; image quality downsampling does not convert a video into a lower-resolution stream. A playback error must be visible, not replaced by an unannounced still.

Treat upload decoding and live playback as two tests. The Mac package includes software AV1 decoding through dav1d for upload inspection and thumbnail creation; this does not add an AV1 hardware decoder or change Electron's browser decoder. A thumbnail proves only that a frame decoded. Test the exact 8K file in the packaged Scene, including continuous playback and the loop join. For a Mac with HEVC hardware support, a separately named HEVC/H.265 MP4 is a candidate delivery when AV1 playback is unavailable or too slow; preserve the original, full 2:1 dimensions, frame rate and color metadata. Do not claim HEVC playback until that file passes the target-device test. Batshit keeps the uploaded bytes and performs no automatic codec conversion.

Use Elevated / Overlook for a distant city. Ground Level remains a projection choice and needs an appropriate panorama. The video is not a weather system: existing Scene Atmosphere rain/snow/particles remain independent. Static props and room textures do not gain animation from this feature.

## Preferred sequence for a stationary world

1. Approve excellent still art, turn it into a seam-corrected panorama, and upscale the still first.
2. Author localized motion on that approved final image. Suitable channels include twinkling existing stars, independently breathing neon, occupied window groups dimming/relighting, and slow changes in existing facade illumination from pink through purple to blue. Keep colors and density appropriate to the user's world; the accepted city palette is not mandatory for other scenes.
3. Distribute activity around the sphere. A count that looks dense in a flat 360 image can be sparse inside one normal field of view. In the accepted city, 28 animated city regions were doubled to 56: 35 neon accents, 14 window groups and seven colored facades, plus 90 existing stars. Judge several normal views, not only the flat panorama.
4. Use different phases and slow periodic envelopes. Smoothly varying colors and brightness can coexist. Preserve approved channels while iterating: adding city lights must not reshuffle the star positions or timing.
5. Inspect all emitters at minimum brightness, then inspect actual encoded video in the sphere. Preserve the source and prior approved version, and save the light plan and generation settings.

This path is authored animation, not AI-generated motion. It keeps high-resolution architectural detail intact and does not require a video diffusion model.

## Mask the illumination, not the bounding box

The initial implementation multiplied full source RGB inside a brightness/saturation mask. Saturated blue haze also passed that mask. Dimming then created dark rectangles/triangles around distant signs and spires. Merely lowering the dimming strength hides the defect instead of isolating the light.

The corrected recipe combines:

- **Color key:** distinguish the intended pink/cyan/amber/bright neutral emission from the surroundings. Cyan lights contain more green relative to blue than the example's blue skyline haze. Retarget thresholds for the new artwork.
- **Local contrast:** estimate non-emissive background from padded spatial context, then keep positive RGB brightness above it. The example uses a 61-pixel elliptical morphological opening and 64-pixel context at 8K; scale these spatial sizes for other resolutions.
- **Emission-only modulation:** `emission = max(source - background, 0)`; `frame = source + emission * mask * envelope`. A negative envelope reduces the light contribution, not the whole underlying building/sky. Keep the minimum above the background floor.
- **No mask growth after keying:** do not blur/dilate the finished subtraction mask into sky. Continuous color/contrast weights and a feathered region edge provide soft transitions without widening the keyed support.

Broad facade color washes are a different mask type. Select existing colored illumination, preserve local shading, and exclude neutral stone and deep shadows. Do not apply the narrow-emitter extraction to an already approved broad wash automatically.

Stars should add a small, localized halo around existing points. Negative halos create dark rings in the sky. Do not repaint the whole sky or mistake compression noise for twinkling.

## Bundled configurable renderer

`assets/animation/animate-panorama.py` implements this workflow using Python, NumPy, Pillow, OpenCV and FFmpeg. It performs no AI inference. The default encoder is CPU `libx264` at 4K; `h264_nvenc` and `av1_nvenc` explicitly select NVIDIA hardware encoding. There is no silent encoder fallback.

Create a JSON light plan. Boxes use pixels in `reference_size`, with the right/bottom edges exclusive. Stars use small boxes centered on existing stars; `color` targets describe broad warm/pink-lit facades. Cycles are integer repeats over the complete loop; phase is radians. Coordinates below demonstrate the schema and must be replaced for the actual artwork:

```json
{
  "reference_size": [8192, 4096],
  "duration_seconds": 12,
  "fps": 24,
  "targets": [
    {"kind":"neon", "box":[2600,2000,2700,2120], "cycles":2, "phase":0.3},
    {"kind":"window", "box":[4000,2700,4140,2780], "cycles":1, "phase":2.1},
    {"kind":"star", "box":[3200,1000,3245,1045], "cycles":3, "phase":1.4},
    {"kind":"color", "box":[5000,2400,5260,2900], "cycles":1, "phase":3.2}
  ]
}
```

To locate candidate stars, use small isolated positive-contrast blobs in a verified clear sky band, reject stretched polar streaks and clouds, space points apart, and inspect the resulting plan. Do not assume a fixed vertical sky band is safe for every composition.

```sh
python animate-panorama.py panorama.png lights.json preview.mp4 --prepare-only
python animate-panorama.py panorama.png lights.json city-4k.mp4 --width 4096 --encoder libx264
python animate-panorama.py panorama.png lights.json city-8k.mp4 --width 8192 --encoder av1_nvenc
ffmpeg -v error -i city-8k.mp4 -f null -
```

Prepare-only writes timed stills, selected-target metadata, per-light mask diagnostics and an `all-lights-minimum.png`. The full render writes encoder logs and a report including frame count, duration and exact endpoint equality. Never overwrite the approved source. Save the artwork-specific plan beside the media; do not expect a previous city's rectangles to fit new art.

For the final accepted city, the original 8K light render took about 28 seconds with the 4090 encoder and produced a 77 MB, 12-second file. This is measured render time, not the time to generate the artwork or author its masks. CPU encoding and other hardware may take longer.

## Loop and encoding invariants

- An integer-frequency periodic envelope gives matching t=0 and t=duration states. Encode one period, excluding the duplicate endpoint. Review the join as video; equality alone does not prove a convincing loop.
- Forward/reverse is useful when motion reverses naturally. Omit duplicated turnaround endpoints. Do not reverse rain, one-way traffic, smoke flow or a shooting star; use a direct periodic design or a suitable forward loop instead.
- Preserve full 2:1 equirectangular projection, horizontal seam continuity, stationary camera and no architecture drift. An accidental crop can invalidate the panorama even if the file is 2:1 afterward.
- Set RGB-to-YUV conversion and metadata consistently. The verified recipe uses BT.709 matrix/primaries, sRGB transfer, limited-range YUV420 and MP4 fast start. For 8K AV1 NVENC, explicitly use level 6.0 high tier. An automatic level 7.3 file failed the installed software decoder; the level 6.0 file decoded correctly.
- Full-decode the output, inspect dark and bright extrema, check all directions/poles/wrap in a sphere, and test inside the intended room. Neighbor pixels can vary after chroma subsampling/compression even when the pre-encode mask preserves them exactly.
- Measure selected lights, not only whole-frame differences. The rejected H3 transfer had changing pixels but no useful perceptual activity. The final mask correction preserved 145,504 classified haze pixels exactly before encoding while retaining substantial emitter variation.

## When to use generative video instead

Use it when the scene needs meaningful moving objects or environmental deformation that cannot be expressed as localized light animation. Compare geometry stability and artwork preservation, not just a model's output resolution.

An H3 FL2VA + equi360 adapter experiment used the same panorama as first and last anchor, 20 steps, 124 frames at 24 fps. It took 12m54s on the 4090 but softened the city and produced essentially no intentional animation under the restrictive prompt. Transferring its tiny RGB changes back onto the sharp still produced mostly shimmer. That route was rejected for this stationary city, not established as a universal failure of H3.

H3's inspected first-frame node stretched the entire input and its last-frame node used cover-crop. Pre-sizing the entire panorama to both conditioning canvases prevented the last anchor from dropping directions. Restore the whole result to 2:1, never recover the aspect ratio by cropping away the sphere. REF2VA uses a different model base; do not assume an equi360 adapter proved on FL2VA is compatible.

## Local and cloud choices

The expensive stage is AI artwork/panorama generation and restoration. A local 24 GB GPU ran the proven Qwen Edit panorama workflow. Without that GPU, run the matching models/nodes on a rented GPU, or use a hosted reference-to-panorama service after verifying its projection and seam quality. The subsequent authored light renderer can run on an ordinary CPU at 4K; a cloud GPU is not inherently required for every frame.

[Comfy Cloud exposes workflow and model/node APIs](https://docs.comfy.org/api-reference/cloud/overview); check actual node/model availability before treating a local graph as portable. [Cloud custom-node support has restrictions](https://support.comfy.org/articles/6791455062-custom-nodes-on-cloud). [Fal's Hunyuan World endpoint](https://fal.ai/models/fal-ai/hunyuan_world) is a hosted image-to-panorama/world alternative, not a measured equivalent of this Qwen recipe. No hosted route was used in the accepted image-first light loop. Earlier hosted restoration attempts failed or rejected the target size, so do not promise that a provider's advertised upscale factor implies 8K support.

Use current provider documentation for pricing, limits, licenses and authentication. Set an explicit spending boundary with the user, reuse authorized credentials securely, and never place keys in scene packs, workflows, plans or skill files. Keep cloud capability leads distinct from locally verified results.
