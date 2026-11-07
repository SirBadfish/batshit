# Image-first panoramas

Read this when a scene starts from a strong perspective reference image. For text-only panorama generation, use `qwen360-skybox-workflow.md`. Animation is separate: read `animated-panorama.md` only when an animated background is requested.

## Proven sequence

1. Create and approve the hero artwork first. A normal landscape image around 16:9 is suitable. Use the available image generator; never claim a particular backend model ID unless the tool exposes it. Define the palette, architecture, atmosphere and viewing height clearly. A successful original city example combined worn neighborhoods, polished towers, cyan/magenta/amber lighting, a starry night and an elevated distant overlook. These are optional art choices, not requirements for every scene.
2. Expand/redraw that reference into a complete 2:1 equirectangular panorama. A perspective image cannot become a full world simply by stretching or projecting it. The proven reference-driven route is Qwen Image Edit 2509 with [QWEN-EDIT_360](https://huggingface.co/mickmumpitz/QWEN-EDIT_360). It redraws the reference and invents other directions; it does not preserve the hero's exact pixels or camera frustum.
3. Inspect the native panorama in a sphere before upscaling. Check all directions, the horizontal wrap, poles and near/far composition. Keep room walls, floor, windows and railings as separate geometry. For an overlook, ensure at least one broad direction opens into distant scenery rather than surrounding the viewer entirely with close buildings.
4. Repair the rear seam if necessary, preserving unaffected pixels. Upscale only after the complete panorama is coherent.
5. Approve the still at normal in-scene viewing size. Native 2K can look attractive as a flat image yet be soft when spread over 360 degrees. Preserve the original hero, native panorama and final still independently.

## Bundled API graph templates

The filenames retain the original city experiment labels; change prompts and input/output filenames for the new scene. Models and generated artwork are not bundled. These are ComfyUI API graphs, not drag-and-drop UI workflow JSON. Inspect the live node inventory and validate the graph before submitting it.

- `assets/comfyui/night-city-full-reference-pano.api.json`: full hero reference -> 2048×1024 panorama -> RealESRGAN ×2 4K output. Qwen Edit 2509 FP8, Qwen 2.5 VL 7B FP8 encoder, Qwen VAE, QWEN-EDIT_360 adapter strength 0.9, 20 steps, CFG 4, seed 360907. In the measured example, passing the full reference directly to the image-edit encoder retained more useful detail than the author's padded-reference example. This is evidence for that composition, not a universal ranking.
- `assets/comfyui/night-city-seam-repair.api.json`: roll by 180 degrees, repair a 256-pixel strip at the center of a 2048-pixel panorama with 32-pixel feathering, composite over the untouched original outside the mask, and roll back. Qwen Edit base without the 360 adapter, 20 steps, CFG 4, seed 360908. Supply the selected native panorama as the graph's input image. Never accept a seam repair that changes the approved front of the world unnecessarily.
- `assets/comfyui/night-city-8k-clean.api.json`: supply the repaired 4K output; another RealESRGAN ×2 pass with horizontally repeated context produces 8192×4096. Repeated context keeps the final upscale aware of the spherical wrap.

The example adapter was `251018_MICKMUMPITZ_QWEN-EDIT_360_03.safetensors` from the upstream model repository. Install the correct Qwen Edit adapter/base pair, not the different text-to-image Qwen 360 adapter. Verify current upstream licenses and model requirements before downloading or choosing a hosted substitute.

On a 24 GB RTX 4090, the above image-first route was completed locally. FP8 model loading and encoder CPU placement reduce memory pressure; generation speed depends on the installed nodes and offloading. The exact VRAM cost is not implied by the final image size.

## Sharpness and projection lessons

- Two RealESRGAN ×2 passes were preferred for the accepted city. A SeedVR2 restoration branch exaggerated crosshatch texture on buildings and was rejected. Inspect outputs rather than treating an upscale model's name or advertised resolution as proof of detail.
- The native rear-seam repair left outside-mask pixels exactly unchanged and reduced mean edge mismatch in that example from 13.16 to 2.17/255. Such metrics help diagnose a repair; visual spherical inspection still decides whether it works.
- Ground Level needs an appropriate 50% equator and a projectable lower hemisphere. Do not reuse an elevated city with close rooftops as a grounded panorama and expect a projection-line adjustment to reconstruct geometry.
- A floor-only or partial room can reveal much more of the panorama than a full room. Judge composition in the intended open stage/window layout.

## When local generation is unavailable

Use a hosted panorama/image-edit service or a rented GPU with the matching model and nodes. Verify reference-image conditioning, full equirectangular output and wrap continuity; a hosted text-to-video endpoint is not automatically a panorama conversion service. Keep provider choice separate from the scene design. Confirm current cost and available balance before a paid run, and retain output/provenance so reruns are deliberate.
