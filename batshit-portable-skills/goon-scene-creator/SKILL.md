---
name: goon-scene-creator
description: Plan Batshit Goon scenes, skyboxes, Room Builder settings, and ComfyUI skybox handoffs from an outside coding agent using a Portable Skill Token.
metadata:
  version: "0.1.0"
  batshitPortableSkill: true
  family: goon-scenes
---

# Batshit Portable Goon Scene Creator

You are running outside Batshit. Your job is to help the user plan and generate Batshit-ready Goon scenes: skybox atmosphere, Room Builder surfaces, scene placement, room textures, props, and sit/lay markers.

This portable skill uses Batshit's local HTTP API only for health and scoped token proof today. It does not directly save or update Goon scene records yet. Do not write Redis directly. Do not edit Batshit app source. Do not use `BATSHIT_TOKEN`, user passwords, copied browser cookies, or n8n callback tokens.

## Required Inputs

Before doing real work, establish:

- Batshit base URL, defaulting to `http://127.0.0.1:5620`.
- Portable Skill Token with the `Goon Scenes` scope.
- the scene concept, mood, and whether the target should be Ground Level or Elevated / Overlook if the user already knows.
- whether this is a Mac/native instance or Docker Batshit when ComfyUI, uploads, or local file paths matter.
- the target texture mode when known: Draft, Standard 4K, or Hero 8K.

If the user has not provided the token, ask them to create one in Batshit Settings -> Skills & Prompts -> Portable Skills and grant `Goon Scenes`. A multi-scope token may be stored once in `~/.batshit/portable-skills/portable-skills.env`; a skill-specific file such as `goon-scene-creator.env` is only needed when the user wants a narrower override token.

Use environment variables for shell calls so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/goon-scene-creator.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/goon-scene-creator.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

If `BATSHIT_PORTABLE_TOKEN` is missing or still equals the placeholder value, stop and ask the user for the token or env-file path before making API calls.

## Handshake

Run this before scene work.

### 1. Health

```bash
curl -sS "$BATSHIT_BASE_URL/api/health"
```

Require `ok: true`. If Batshit is not reachable, stop and tell the user to start Batshit or provide the correct base URL.

### 2. Token Proof

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"controlId":"sys.goon_scene.creator_info","input":{}}'
```

Require a successful response. If the response says the token lacks scope, stop and tell the user to rotate or create a token with `Goon Scenes`.

## Current Capability Boundary

This portable skill can:

- design a complete scene contract for Batshit Scene Editor;
- write skybox prompts, negative prompts, and texture guidance;
- choose Standard 4K versus Hero 8K honestly;
- choose one scene-wide placement: Ground Level or Elevated / Overlook;
- specify the saved Ground Projection Line, normally 50% for Ground Level;
- specify Uploaded GLB Room Shell uniform scale, X/Y/Z offset, and Y rotation when that room source is used;
- choose one built-in Scene Atmosphere preset and placement;
- remember that Outside atmosphere needs an open or transparent room surface to be visible;
- guide ComfyUI skybox generation with the bundled Qwen 360 workflow files;
- produce copy-ready Scene Editor import steps in current order: World, Room Builder, Props, Markers.

This portable skill cannot currently:

- create, update, or save Batshit Goon scene records through Fabric controls;
- upload scene files into Batshit by bypassing the app;
- promise custom ambience sprites, multiple ambience layers, animated props, GIFs, or video textures;
- create mixed half-ground / half-overlook panoramas that require masked transition geometry.

If future Batshit Goons/Scenes Fabric controls exist, discover their schema first with `/api/controls/find` and use them only when the token family allows them. Until then, hand off clean Scene Editor steps.

## Mandatory References

Read references before producing final scene instructions:

- Always read `references/batshit-scene-spec.md`.
- Read `references/skybox-generation.md` when prompting or validating a skybox.
- Read `references/qwen360-skybox-workflow.md` when installing, using, or troubleshooting the bundled ComfyUI workflow.
- Read `references/lofi-showcase-aesthetics.md` for cozy, lofi, cinematic, ambience-heavy, or showcase scenes.

The bundled ComfyUI workflow assets live under:

- `assets/comfyui/qwen360-skybox-api-workflow.json`
- `assets/comfyui/qwen360-skybox-ui-workflow.json`
- `assets/comfyui/qwen360-skybox-metadata.json`

The workflow files do not include model weights, LoRAs, VAEs, or upscalers. Missing ComfyUI models or nodes are blockers to report clearly, not something to hide behind a different model.

## Resolution Policy

Choose texture resolution deliberately.

| Mode | Final skybox size | Typical file size | Use when |
| --- | ---: | ---: | --- |
| Draft | 2048x1024 | small | early concept checks, weak machines, or quick prompt iteration |
| Standard | 4096x2048 | about 10-12 MB | smaller or lower-memory Macs/PCs, unusually heavy scenes, or performance trouble |
| Hero | 8192x4096 | about 30-35 MB | recommended final skybox for best scene quality |

Recommend Hero 8K for final skyboxes. Use Standard 4K for smaller or lower-memory Macs/PCs, unusually heavy scenes, many mounted skyboxes, or performance trouble. Draft remains an iteration mode rather than the preferred final export.

Runtime note: the embedded Mac app gives skyboxes their own texture budget. Ultra can use Hero 8K when the graphics device supports it, Auto/High use up to Standard 4K, and Low uses up to 2K. Avatar and room textures keep separate budgets.

Even when the final output is 4K, include high-detail language in the prompt:

```txt
Ultra high detailed, 8K texture detail, crisp high-frequency micro-detail, sharp fine surface detail
```

Upscaling belongs after the image is already a 2:1 equirectangular panorama. For Hero 8K, the proved path is 2048x1024 base -> 4096x2048 upscale -> 8192x4096 upscale.

## Scene Placement

Choose one placement for the whole scene.

Scene Placement lives under Scene Editor -> World and is independent from Uploaded GLB versus Procedural Builder room selection. World also owns Skybox and Scene Atmosphere. Room Builder owns the room source, Room Shell upload, textures, dimensions, and surfaces.

Use **Ground Level** when the room should feel planted in outdoor terrain:

- forest cabin, meadow cottage, beach shack, garden studio, courtyard, patio, mossy ruin, one-story terrain scenes.
- Target the exact equirectangular equator at 50% image height. Everything below it must be continuous projectable floor/terrain/water only, with nearby upright furniture, walls, screens, trees, rocks, buildings, and columns kept out of the lower hemisphere.
- Tell the user to choose Ground Level in Scene Editor.
- Tell the user to leave Ground Projection Line at 50% for generated assets. It can correct a globally misplaced existing horizon, but cannot repair upright content already painted below the line.

Use **Elevated / Overlook** when the room should feel above, floating, or looking out over distance:

- high-rise lounge, rooftop deck, balcony, cliff, ship, space, floating room, city overlook.
- Prompt the whole skybox as an elevated/open view.
- Tell the user to choose Elevated / Overlook in Scene Editor.

Do not design mixed scenes where one side is Ground Level and another side is an overlook. A convincing version needs a hard art-directed transition along real geometry such as rails, cliffs, columns, walls, or masks. Batshit does not currently cut the grounded skybox projection that way.

## Workflow

Follow this order:

1. Understand the scene intent and whether it should be Ground Level or Elevated / Overlook.
2. Load the required references.
3. Choose Draft, Standard 4K, or Hero 8K.
4. Define the scene contract: skybox, Room Builder size/surfaces or Uploaded GLB placement, scene placement, Ground Projection Line, Scene Atmosphere, textures, props, sit markers, lay markers, and import steps.
5. If ComfyUI is available, use the bundled workflow references and assets. If it is unavailable, provide copy-ready prompts and exact asset specs.
6. Validate skybox requirements: 2:1 aspect ratio, equirectangular projection, horizontal wrap continuity, no readable text/logos/seam, and an exact 50% guide proving a Ground Level lower hemisphere contains projectable ground/floor only.
7. Provide Scene Editor handoff steps in the current level-one order: World (Skybox, Scene Placement, Scene Atmosphere), Room Builder (Uploaded GLB or procedural surfaces), Props, then Markers. Do not claim scene records were saved unless a real Batshit scene-save Fabric control was used successfully.

## Output Shape

For a finished scene plan, answer with:

- scene name and one-sentence intent;
- texture mode: Draft, Standard 4K, or Hero 8K;
- skybox prompt and negative prompt;
- Room Builder plan: size, wall/ceiling/floor surfaces, texture notes;
- scene placement: Ground Level or Elevated / Overlook;
- Ground Projection Line for Ground Level, normally 50%;
- Uploaded GLB Room Shell Placement when relevant, including whether Align Floor or manual Y adjustment needs visual confirmation;
- Scene Atmosphere: off, or one built-in preset with placement;
- prop list with placement notes;
- sit/lay marker list;
- ComfyUI workflow notes when relevant;
- Scene Editor import/save steps;
- performance note and current Batshit limitations.

Do not call the scene done if the files were not generated, the panorama is not a 2:1 equirectangular image, or Batshit could not import/save the scene.
