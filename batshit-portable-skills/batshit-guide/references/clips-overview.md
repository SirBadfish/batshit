# Clips

A Clip is a reusable attachment stored in Batshit — an image, text file, PDF, video, or other supported file. Upload it once, then reference it across messages and sessions without pasting raw data into the chat.

Clips keep image and file bytes out of your prompt text. For compressing large *output* — long logs, tool results — see [Zips and context](../tools/zips.md) instead.

## When to use a Clip

- Attach an image to a chat.
- Reuse the same file across sessions.
- Let the Clip Vault remember a file.
- Save an Artifact-generated image or output back into chat.
- Send media through Batshit's structured upload pipeline.

A Clip can stay clipped to the composer until you remove it. You can also mark a Clip as next-message-only, so it's used for one send and then dropped from the composer automatically.

## Storage and delivery

Batshit stores Clips locally through batshit-server. There's one storage shape; the delivery format is chosen when a message is actually sent:

| Situation | What Batshit sends |
| --- | --- |
| Local AI, automatic image transport | A structured `data:image/...` input built from local upload storage. |
| Local AI, forced URL transport | A URL rewritten to the runtime's configured image base URL. |
| Cloud/non-local model with a live tunnel | A temporary tunnel URL built from the current tunnel host and the clip's reusable upload path. |
| Cloud/non-local model with no tunnel | A structured `data:image/...` input built at send time. |

The tunnel only exposes read-only serving of your uploaded clips, plus a health check — not Batshit's APIs. Upload, command, and admin routes still require an internal service token, so they answer `401` through the tunnel.

If a Clip works in your browser but fails for an agent or Artifact, the current tunnel or Local AI image base URL probably doesn't match the caller. Docker has more than one "localhost" — see [Ports and URLs](../reference/ports-and-urls.md) for the caller rules.

If the selected model has Vision turned off, Batshit treats it as text-only and blocks image Clips before sending. Image transport settings fix the URL shape; they can't make a text-only model understand images.

## Image Clips

Images are sent as structured image inputs, never as raw base64 text inside the prompt — raw image text explodes token usage and makes conversations unreadable. Depending on the provider or runtime, Batshit uses a fetchable URL, a local data URL, or a provider-specific upload path.

The rule for you is simple: upload images as Clips instead of pasting image data into the message.

## Text and binary Clips

Text-like Clips can contribute their text to the model when appropriate. Binary files usually stay as URLs and metadata unless a tool or runtime knows how to process them.

To have an agent read a text file from a Project, a [file mention](../projects/overview.md#file-mentions) is often better than a Clip. For a binary, image, PDF, or reusable media file, a Clip is the right tool.

## Clips vs Zips

These two are easy to mix up. Clips hold things *you* bring in; Zips compress things the *agent* produces.

| System | Stores | Main purpose |
| --- | --- | --- |
| Clip | Files and media you (or an Artifact) provide. | Reuse and attach files. |
| Zip | Large assistant or tool output. | Save tokens while keeping output inspectable. |

For example: you upload a screenshot — that's a Clip. The agent runs a tool and returns a long terminal log — that's a Zip. An Artifact generates an image and shares it to chat — Batshit saves the image as a Clip and may represent related tool output as a Zip. Zips have their own page: [Zips and context](../tools/zips.md).

## Practical workflow: image analysis

1. Upload the image as a Clip.
2. Keep it clipped for as long as the agent should consider it.
3. Mark it next-message-only if it should be used once.
4. Remove it when the conversation no longer needs it.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Clip works in browser but not for the model | The URL isn't reachable from the model/runtime. | Local/tunnel/data-URL strategy and the caller URL. |
| Docker agent cannot reach a `localhost` Clip URL | Inside Docker, `localhost` means the container. | Use service names or `host.docker.internal`; see [Ports and URLs](../reference/ports-and-urls.md). |
| Image Clip is blocked before sending | The selected model preset has Vision off. | Switch to a vision-capable preset or remove the image. |

## Related docs

- [Projects and files](../projects/overview.md)
- [Zips and context](../tools/zips.md)
- [Artifacts](../artifacts/overview.md)
- [Security and trust](../security/overview.md)
