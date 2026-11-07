# ComfyUI Reference

**Load when:** a ComfyUI artifact needs input-image uploads, a list of installed models, a cancel button, or you are fixing a ComfyUI error, checking a model family's usual settings, or looking up an endpoint. Planning is in `brain-comfyui.md`, the build in `comfyui-build.md`.

All calls go through the proxy with `comfyUrl()` and `window.batshit._fetch()` (`comfyui-build.md`).

## Uploading an input image

For img2img, ControlNet, or inpainting workflows:

```javascript
async function uploadImage(file) {
  const form = new FormData();
  form.append('image', file);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const response = await window.batshit._fetch(comfyUrl('upload/image'), { method: 'POST', body: form });
  const { name } = await response.json();
  return name; // then: prompt["<LoadImage node id>"].inputs.image = name
}
```

Use Builder Kit's `uploadButton()` or `dropFile()` for the picker (they take no `fabricId`).

## Installed models

Fill a model picker from the user's install instead of hardcoding names:

```javascript
const checkpoints = await (await window.batshit._fetch(comfyUrl('models/checkpoints'))).json();
const loras = await (await window.batshit._fetch(comfyUrl('models/loras'))).json();
const stats = await (await window.batshit._fetch(comfyUrl('system_stats'))).json();
```

## Cancel

```javascript
async function cancelQueue() {
  await window.batshit._fetch(comfyUrl('interrupt'), { method: 'POST' });
  await window.batshit._fetch(comfyUrl('queue'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true })
  });
}
```

## Errors

| Error | What happened | What to do |
|---|---|---|
| `Failed to fetch` / network error | ComfyUI is not running, or the base alias is wrong | Check ComfyUI is open; check desktop vs standalone alias |
| `400 missing_prompt_field` | The `/prompt` body shape is wrong | Send `JSON.stringify({ prompt: promptPayload, client_id })`, never the bare node map |
| `400 ui_workflow_not_prompt` | A UI graph was submitted | Check `workflow_format`; load or convert to API format |
| `500` right after `/prompt` | Usually a UI graph sent as `prompt` | Same as above |
| `error` status in history | The workflow failed (often a missing model or bad input) | Show the error; ComfyUI's own console has details |
| Model not found | The file is not in the right models folder | Guide them to `ComfyUI/models/checkpoints/` (or `loras/`, ...) |
| Custom node missing | A node pack is not installed | ComfyUI -> Manager -> Install Custom Nodes, search by name |
| VRAM / memory error | The GPU ran out of memory | Lower resolution, steps, or batch size; on a Mac try `--lowvram` |
| Job stuck | A hung queue from an earlier failure | Run the cancel helper, then retry |
| Seems to run forever | Slow hardware or a heavy workflow | Keep polling unless they want a limit; improve progress text; offer Cancel |

## Usual settings by model family

Use these to tell "normal" from what the user customized:

| Setting | SD 1.5 | SDXL | Flux (dev) | Flux (schnell) |
|---|---|---|---|---|
| Steps | 20-30 | 25-35 | 20-28 | 1-4 |
| CFG | 7.0 | 7.0 | **1.0** | **1.0** |
| Sampler | euler_a | dpmpp_2m | euler | euler |
| Scheduler | karras | karras | simple | simple |
| Negative prompt | Yes | Yes | **No** | **No** |
| Best resolution | 512-768px | 1024px | 1024px | 1024px |

- **Flux** ignores negative prompts and needs CFG 1.0; if their Flux workflow has them, they do nothing.
- **SD 1.5** is best at 512-768px; larger without upscaling looks worse.
- **SDXL** is tuned for 1024px (1024x1024, 1152x896, 896x1152).

| Format | SD 1.5 | SDXL / Flux |
|---|---|---|
| Square | 512x512 | 1024x1024 |
| Portrait | 512x768 | 896x1152 |
| Landscape | 768x512 | 1152x896 |
| Widescreen | 768x432 | 1344x768 |

## Video workflows (Wan 2.1 and similar)

Outputs are video files. Their key in the job's `outputs` depends on the node that saves them, so read it from a real finished job before you write the display code; show them in `<video controls>` after `resolveMediaUrl()`. Runs take 5 to 20+ minutes even on good hardware; make the progress display prominent and never add a short timeout.

## Endpoints (through the proxy)

| Endpoint | Method | What it does |
|---|---|---|
| `/prompt` | POST | Queue an **API-format** prompt (`{ prompt, client_id }`); returns `prompt_id` |
| `/history/{prompt_id}` | GET | Job status and output filenames |
| `/view` | GET | An output image or video by filename |
| `/upload/image` | POST | Upload an input image |
| `/queue` | GET / POST | Read or clear the queue |
| `/interrupt` | POST | Stop the current job |
| `/userdata?dir=workflows` | GET | Saved workflow filenames |
| `/userdata/workflows%2F<name>.json` | GET | One saved workflow |
| `/object_info` | GET | Node schemas (targeted only, never the full dump) |
| `/models/{folder}` | GET | Installed models in a folder |
| `/system_stats` | GET | GPU, CPU, and VRAM info |
