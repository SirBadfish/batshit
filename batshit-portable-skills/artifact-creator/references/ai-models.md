# Choosing the Artifact's Model

**Load when:** a Built-in AI artifact needs its model chosen or repaired: `sys.model_catalog.search`, the `model_config` shape, saved provider keys, and what to do when a run returns nothing. Skip it for static, n8n, and webhook artifacts.

The artifact owns its model; there is no global artifact default. A finished Built-in AI artifact stores an exact model in `model_config` on create. Without one it saves as `source: "auto"` with `modelId: null`, a draft that fails at run time until a model is set.

## Find the exact model

1. Search the catalog: `sys.model_catalog.search` with `query` (the model or family the user named), and optional `provider`, `purpose` (`chat`, `visual`, `audio`, `utility`), and `limit`. Example input: `{ "query": "Claude Haiku 4.5", "provider": "anthropic", "purpose": "chat", "limit": 5 }`.
2. Pick the row that matches what the user asked for, and store its `artifact.modelConfig` as `model_config` in `sys.artifact.create`.
3. If the user named no model and the job needs AI, ask one short question ("Which model should this use?"). If the named model is missing, unavailable, or ambiguous, ask. **Never silently choose a fallback or substitute model:** it causes surprise cost and hides that the intended model or provider is failing.
4. Use the web only when the catalog cannot answer and the request names a current, provider-branded model.

Batshit's words:

- **Provider / connection:** the route and API key Batshit calls, such as Google direct, OpenAI direct, Fal direct, or OpenRouter (`direct:google`, `direct:fal`, `openrouter`, `vercel-gateway`).
- **Developer:** who made the model (Google, OpenAI, Anthropic, Black Forest Labs, ...). A Google model served through Fal has `developer: "google"` but connection `direct:fal`; if the user asked for Google direct, do not pick the Fal row without asking.
- **Model ID:** the exact callable string, `modelIdForArtifact` in the result.

## Reading a catalog result

- `artifact.modelConfig`: the exact `model_config` to store for a normal single-model artifact.
- `modelIdForArtifact`: the only value that goes in `model_config.primary.modelId`.
- `artifact.runtime.connection`, `provider.connectionId`, `variants[].connectionId`: which route can call it. Use them to choose, not as extra fields.
- `artifact.runtime.outputKind`: `image`, `video`, `3d`, or broader visual. An image generator needs `image`; `purpose: "visual"` also returns video and 3D models.
- `artifact.runtime.savedApiKeyService`: the saved provider key a direct call needs. Check it against `user_api_keys_configured` in your session context (a portable agent asks the user). You can see whether a key is saved, never its value. If it is missing, ask the user to save that key; do not switch providers or use an environment key.

## The `model_config` shape

```json
{ "model_config": { "mode": "basic", "primary": { "source": "manual", "modelId": "<modelIdForArtifact>" } } }
```

Do not add `provider`, `developer`, `connection`, `transport`, or `effectiveId`; Batshit rehydrates the route from the catalog at run time. Use `source: "preset"` only when the user named an existing saved Model Manager preset and you know its exact ID; an unknown preset ID is refused.

An artifact that lets the user pick among several models at run time must say so in its UI and pass the chosen exact ID as `model` in every call.

## Setting or repairing it later

- `sys.artifact.update` with `artifactId` and the same `model_config` shape, or the per-artifact control `artifact.<id>.field.model.set` with `{ "model": "<modelIdForArtifact>" }`.
- The update's summary lists `model_config` in `artifactUpdate.updatedFields`; that is your confirmation. Call `sys.artifact.get` only when `model_config` is missing from that list or a run still uses the old model.
- Clearing the model leaves the artifact with none; runs then fail clearly until a model is set.

## Quick path: Built-in AI image generator

1. Search with `purpose: "visual"` and the provider terms the user used.
2. Pick a row with `artifact.runtime.outputKind: "image"` whose connection matches the user's request.
3. Check its `savedApiKeyService` against `user_api_keys_configured`.
4. Build with `window.batshit.generateImage()` (or `complete()` + `onFile` if the row says the model answers through chat), Builder Kit fields with the semantic image `fabricId`s, and `standardControls()` with an `image` share payload.
5. Create with the row's `artifact.modelConfig` and `mode: "published"`.
6. Run it once and read `sys.artifact.run_logs.get`: `result.fileCount` (or `generatedFileCount`) must be above 0. A save and publish with zero files is not done.

## When it goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| A run ends fast with no image | A chat, video, or 3D model on an image artifact; the provider key is missing; or the wrong helper | Re-search with `purpose: "visual"`, pick `outputKind: "image"`, check the saved key, update `model_config`, run again |
| The output is the wrong kind | The save checks the page, not the model's modality | Check the row's `outputKind`, then `sys.artifact.run_logs.get` |
| Update succeeded but runs use the old model | Wrong payload shape or artifact ID | Check `updatedFields`; send the exact manual shape above |
| `CONTROL_NOT_ALLOWED` on `sys.model_catalog.search` | A Batshit control-scope limit, not a sandbox permission | Say so plainly; use a model ID the user gives you, or ask for one |
| Several rows look alike | One model through several connections | Pick the connection the user asked for; ask before changing it |

Run logs (`sys.artifact.run_logs.list`, then `.get`) show the chat link, a scrubbed prompt preview, the resolved model, the route, output counts, usage, and sanitized errors. They never hold keys, tokens, or raw image or audio bytes; they are kept about two weeks and deleted with the artifact.
