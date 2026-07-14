# Qwen 360 Skybox Workflow

Use this reference when the user wants to run Batshit's bundled local ComfyUI skybox workflow, install the visible workflow into ComfyUI, or troubleshoot the workflow assets.

## Repo-Owned Asset Location

The Batshit-owned workflow assets live in:

```txt
batshit-app/src/lib/server/system-skills/goon-scene-creator/assets/comfyui/
```

Files:

| File | Purpose |
|---|---|
| `qwen360-skybox-api-workflow.json` | MCP/API workflow template with `PARAM_*` placeholders. |
| `qwen360-skybox-ui-workflow.json` | Visible ComfyUI workflow graph for Comfy Desktop or standalone ComfyUI. |
| `qwen360-skybox-metadata.json` | Model files, node classes, defaults, output modes, and hardware notes. |

The visible workflow should be installed into ComfyUI as:

```txt
batshit_qwen360_skybox.json
```

Do not claim the model weights ship with Batshit. The repo ships workflow definitions only.

## Install the Visible Workflow

From the Batshit repo root, run:

```sh
node tools/comfyui/install-goon-scene-skybox-workflow.mjs
```

The helper tries common Comfy Desktop paths and environment variables. If it cannot find the workflows folder, pass it explicitly:

```sh
node tools/comfyui/install-goon-scene-skybox-workflow.mjs --target "C:\path\to\ComfyUI\user\default\workflows"
```

Useful environment variables:

- `COMFYUI_USER_WORKFLOWS_DIR`
- `COMFYUI_WORKFLOWS_DIR`
- `COMFYUI_ROOT`

The helper copies `qwen360-skybox-ui-workflow.json` to the target as `batshit_qwen360_skybox.json`. If that file already exists and differs, the helper creates a timestamped `.bak` backup before replacing it.

## MCP/API Template

Agents or MCP wrappers should use:

```txt
qwen360-skybox-api-workflow.json
```

That file contains `PARAM_*` placeholders for values such as prompt, seed, width, height, steps, CFG, LoRA strength, and filename prefix. The raw file is a template for a wrapper that performs parameter substitution. Do not submit it unchanged to ComfyUI `/prompt`.

## Required Runtime Assets

The workflow expects these model files to be installed in ComfyUI's normal model folders:

| File | Model family |
|---|---|
| `qwen-image-2512-Q6_K.gguf` | `models/unet` |
| `Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf` | `models/clip` |
| `qwen_image_vae.safetensors` | `models/vae` |
| `qwen-360-diffusion-2512-int8-bf16-v2.safetensors` | `models/loras` |
| `RealESRGAN_x2plus.pth` | `models/upscale_models` |

The workflow also requires these node classes:

- `UnetLoaderGGUF` and `CLIPLoaderGGUF` from ComfyUI-GGUF.
- `LoraLoaderModelOnly`.
- `ModelSamplingAuraFlow`.
- `CFGNorm`.
- `EmptySD3LatentImage`.
- `UpscaleModelLoader` and `ImageUpscaleWithModel`.

If ComfyUI reports a missing node, use ComfyUI Manager or the runtime's missing-node message to install the provider. Do not silently remove the node or swap to a different model.

## Output Modes

- Draft: stop at `2048x1024`.
- Standard 4K: run the included 2x upscale and export `4096x2048`.
- Hero 8K: run one additional x2 upscale after the workflow output to reach `8192x4096`.

The proven quality path generates the 2:1 equirectangular panorama first, then upscales last. Keep that order.

## Prompt Baseline

The visible workflow's default positive and negative prompt nodes are configured for **Ground Level**. For an Elevated / Overlook scene, replace both nodes with the Elevated baselines below; changing only the positive prompt would leave contradictory ground-projection negatives active.

Include the detail and panorama language from `skybox-generation.md`, especially:

```txt
Ultra high detailed, 8K texture detail, crisp high-frequency micro-detail, sharp fine surface detail
```

And:

```txt
true 360 degree equirectangular panorama, 2:1 aspect ratio, seamless horizontal wrap, centered eye-level horizon, coherent lower hemisphere, projection-safe panorama
```

For a Batshit **Ground Level** skybox, replace the generic horizon wording with:

```txt
Ground-projection-safe panorama, exact equirectangular equator at 50% image height, entire lower hemisphere contains only continuous ground, floor, terrain, grass, dirt, sand, or water extending from the camera into the distance, all nearby upright and vertical objects remain out of the lower hemisphere, no close foreground furniture or architecture
```

Add these Ground Level negatives:

```txt
upright objects below the equator, vertical forms in the lower hemisphere, furniture below the equator, walls crossing the equator, television below the equator, trees or rocks below the equator, close foreground objects, broken ground band, multiple horizons
```

Keep Batshit's Ground Projection Line at its default `50%` for newly generated assets. The saved adjustment is for correcting an existing panorama with a globally misplaced horizon; it cannot repair upright content already mixed into the lower hemisphere. Before handoff, overlay an exact 50% horizontal guide on the flat output and verify everything below it is projectable ground/floor only.

For **Elevated / Overlook**, use:

```txt
elevated open panorama, lower view remains distant world rather than projectable ground, rooftop, balcony, cliff, ship, space, or city-overlook composition as appropriate
```

Replace the Ground Level negatives with:

```txt
text, logos, watermarks, signature, visible seams, border, frame, cropped panorama, broken horizon, distorted horizon, duplicate sun, warped buildings, low detail, blurry, jpeg artifacts, close foreground floor, nearby ground filling the lower hemisphere, enclosed ground-level room
```

Elevated mode does not require the lower hemisphere to be projectable ground and should not inherit the Ground Level equator restrictions.

## Failure Rules

- Missing model files should produce a clear ComfyUI error and setup guidance.
- Missing node classes should produce a clear ComfyUI error and setup guidance.
- Do not substitute a different base model, LoRA, VAE, or upscaler without telling the user.
- Do not silently downgrade a requested Hero 8K output to Standard 4K.
- Do not bundle model weights, LoRAs, or upscalers in the Batshit repo.
