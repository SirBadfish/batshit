# Voice clones and Voice Studio

A voice clone is a saved voice profile built from a short reference audio sample, so an agent can speak in a chosen voice instead of a generic stock one — and Voice Studio is where you create, preview, and save those profiles. This page explains what clones are, why cloning depends on your provider or engine, what reference audio you'll need, and the privacy care a voice sample deserves. For the wider voice picture, see [Voice](overview.md) and [Voice settings](voice-settings.md).

## What a voice clone is

Normal text-to-speech (TTS) reads agent replies in one of a provider's built-in voices. A voice clone goes further: you give Batshit a reference sample of a voice, and a clone-capable provider or engine learns to speak in something close to it. You save that as a named profile and assign it globally or per agent.

People use clones to give a specific agent a consistent, recognizable voice, to match a [Goon](../goons/overview.md) character, or to use a custom voice a provider's stock list doesn't offer. Once saved, a clone plays through the same speech path as any other reply voice, so it works in normal chat and in Group Chat playback.

Voice Studio is the workflow for this. It lives in Settings → Voice → Voice Studio, where you upload a reference clip, optionally add or auto-transcribe reference text, preview the result, name it, and save. Saved clones are listed there for preview and reuse.

## Clone support depends on the provider or engine

This is the part to get right: cloning is not universal. Some providers and engines support it, many don't, and Batshit won't pretend.

- If the selected provider or bring-your-own (BYO) engine genuinely supports the clone behavior Batshit needs, Voice Studio can save a clone for it.
- If it doesn't, cloning simply isn't offered for that provider. Batshit won't fake a clone or silently fall back to a stock voice and call it a clone.

So the question isn't only "can Batshit clone?" — it's "does the voice provider or engine I've chosen support cloning?" Pick a clone-capable voice provider or engine first, then build the profile.

## Reference audio requirements

Clone quality starts with the reference sample. Good hygiene:

- Use a clean recording — clear speech, minimal background noise, no music under the voice.
- Add reference text (a transcript of what's spoken in the sample) when the engine benefits from it. Voice Studio can transcribe the sample for you through a chosen speech-to-text provider, and you can edit the result before saving.
- Preview the clone before relying on it in chat.
- Save it under a clear name, then assign it globally or to a specific agent.

### Local and BYO engines need a readable reference path

Clone-capable local or BYO engines have an extra rule: the engine has to be able to read the reference audio as a file path on the machine where the engine actually runs.

- On Mac app or source-checkout Batshit, where the engine runs on the same machine, Batshit manages the reference sample locally so the engine can read it.
- In Docker, a host-local speech engine runs outside the app container. The reference sample has to be stored on the host through Batshit's approved operator path, not only inside the app container. The container's private internal path is invisible to a host-native engine, so a clone sample that only exists inside the container is useless to that engine. Batshit handles this by writing host-local clone samples to the host through the authenticated operator — but it's worth understanding why, because "it works on Mac but not in Docker" usually traces back to this boundary.

If a local clone won't play, confirm the engine can actually reach the reference file on its own side of that boundary.

## Privacy and sensitivity

Treat a voice sample as sensitive personal data, because it is.

A recording of someone's voice can identify that person, and a usable clone of it can make speech that sounds like them. Once a voice sample — or a clone built from it — has been shared or copied somewhere, it can be hard or impossible to fully revoke. That's a meaningfully different risk from deleting a text file.

Practical care:

- Only clone voices you have the right to use. Cloning someone without their clear consent can be harmful and, in some places, unlawful.
- Keep reference clips and clone profiles private. Don't post them in bug reports, chat logs, public issues, or shared backups.
- Remember that a With Secrets backup or an exposed local engine can carry voice data further than you intended.
- Delete clones and their reference samples when you no longer need them. Deleting a Batshit-managed BYO engine also removes the voice clone profiles and managed reference-audio created for it.

For the broader trust model — backups, exposed local services, and what Batshit does and doesn't protect — see [Security and trust](../security/overview.md).

## Troubleshooting

### Cloning isn't offered

The selected provider or engine probably doesn't support the clone behavior Batshit needs. Switch to a clone-capable voice provider or BYO engine, then open Voice Studio again.

### A clone saves but sounds wrong in chat

Confirm the clone profile is the one selected for the global default or the agent, that the reference sample was clean, and that any reference text matches what's spoken. Preview from Voice Studio to compare against chat playback.

### A local clone won't play in Docker

The host engine likely can't read the reference audio. Make sure the sample is stored on the host through the approved operator path, not only inside the app container.

## Related docs

- [Voice](overview.md)
- [Voice settings](voice-settings.md)
- [Security and trust](../security/overview.md)
