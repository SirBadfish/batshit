# Portable Goon Scene Creator

The Portable Goon Scene Creator lets an outside coding agent plan Batshit Goon scenes, skybox prompts, Room Builder settings, and ComfyUI skybox handoffs through a Portable Skill Token.

Use it when you want a coding agent outside Batshit to help design a scene, produce skybox prompts, use the bundled Qwen 360 ComfyUI workflow files, and give you clean Scene Editor steps.

## What you need

- Batshit running locally.
- A Portable Skill Token with the `Goon Scenes` scope.
- The downloaded `goon-scene-creator` Portable Skill bundle.
- A scene idea or reference direction.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## What the skill is allowed to do

With the `Goon Scenes` scope, the outside agent can prove access with `sys.goon_scene.creator_info` and retrieve the current Goon Scene Creator capability boundary.

It can help create:

- skybox prompts and negative prompts;
- Draft, Standard 4K, or Hero 8K texture recommendations;
- one scene-wide placement choice: Ground Level or Elevated / Overlook;
- a Ground Projection Line, normally 50% for Ground Level;
- Uploaded GLB Room Shell scale, offset, and Y rotation when relevant;
- Room Builder surfaces and texture notes;
- props and sit/lay marker plans;
- ComfyUI workflow instructions using the bundled Qwen 360 assets;
- Scene Editor import/save steps.

Current Scene Editor order is **World**, **Room Builder**, **Props**, **Markers**. World owns Skybox, Scene Placement, Ground Projection Line, and the one saved built-in Scene Atmosphere layer. Room Builder owns Uploaded GLB versus Procedural Builder room geometry plus Room Shell Placement.

For final skyboxes, Hero 8K is recommended. Use Standard 4K for smaller or lower-memory Macs/PCs, unusually heavy scenes, or performance trouble.

It should not:

- claim it saved a scene record unless a real Goons/Scenes Fabric save control exists and succeeds;
- bypass Batshit uploads or write Redis directly;
- design mixed half-ground / half-overlook panoramas;
- promise custom atmosphere sprites, multiple atmosphere layers, animated props, GIFs, or video textures before Batshit supports them.

## Placement rule

Scenes should be either all-around Ground Level or all-around Elevated / Overlook.

Use Ground Level for forest cabins, meadows, patios, gardens, beaches, courtyards, ruins, and one-story terrain scenes.

For Ground Level assets, the panorama equator should be exactly 50% of image height and everything below it should be continuous projectable ground/floor only. The saved line can correct a globally misplaced horizon, but it cannot repair nearby furniture, walls, trees, rocks, or other upright content already inside the ground band.

Use Elevated / Overlook for high-rises, rooftops, balconies, cliffs, ships, space, floating rooms, and city views.

Do not ask the agent to split the panorama into ground on one side and overlook on another side. Batshit does not yet have transition geometry or masks for that kind of hard edge.

## Recommended prompt

```txt
Use the Batshit Portable Goon Scene Creator.

Batshit base URL: http://127.0.0.1:5620
Token env file: ~/.batshit/portable-skills/portable-skills.env

Plan a Batshit Goon scene for [describe the scene]. Choose Ground Level or Elevated / Overlook, create the skybox prompt and negative prompt, include Room Builder settings, and give me Scene Editor import steps.
```

If ComfyUI should generate the skybox, say whether this is Mac/native Batshit or Docker and where ComfyUI is running.

## Completion should prove

A good completion report includes:

- scene name and intent;
- texture mode: Draft, Standard 4K, or Hero 8K;
- scene placement: Ground Level or Elevated / Overlook;
- Ground Projection Line for Ground Level, normally 50%;
- Room Shell Placement when an Uploaded GLB is used;
- skybox prompt and negative prompt;
- Room Builder plan;
- prop and marker notes;
- ComfyUI workflow result or clear blocker;
- Scene Editor import/save steps;
- any current Batshit limitation that still requires manual work.
