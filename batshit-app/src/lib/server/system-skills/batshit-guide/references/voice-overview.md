# Voice

Voice lets agents listen and speak through speech-to-text (STT) and text-to-speech (TTS). It works on its own, and it pairs naturally with [3D Goons](../goons/overview.md), which animate and lip sync while an agent speaks. This page is the mental model; for hands-on setup, see [Voice settings](voice-settings.md).

## Voice basics

Voice has three related ideas:

| Term | What it means |
| --- | --- |
| TTS | Text-to-speech: Batshit turns an agent reply into audio. |
| STT | Speech-to-text: Batshit turns your microphone or uploaded audio into text. |
| Voice Mode | A phone-style conversation flow where Batshit listens, submits turns, speaks replies, and handles interruption where supported. It's continuous only when the selected Voice Mode STT lane supports realtime microphone input. |

Don't assume every provider supports every lane. A provider can transcribe uploaded audio without supporting realtime microphone Voice Mode, and it can do batch TTS without supporting direct realtime TTS.

## Voice lanes

- **Browser STT** is the free, default, browser-dependent voice input lane.
- **Deepgram Flux** is the first launch-supported cloud realtime STT Voice Mode lane, when a Deepgram key with the right permissions is configured.
- **Fish Audio and Inworld** are Batshit's direct realtime TTS providers, when the matching API key and voice are configured.
- OpenAI, Deepgram, Fish, MiniMax, MiMo, Alibaba Cloud, Inworld, Cartesia, Async, StepFun, Azure Speech, and other cloud lanes can also handle recorded/uploaded-audio transcription or batch speech where the provider supports it.
- OpenAI, ElevenLabs, and Mistral realtime STT models are tracked as future live bridge candidates, but they are not launch-supported realtime microphone lanes until Batshit proves the full live transport path for each one.
- Fish recorded/uploaded-audio ASR is supported, but Fish isn't a realtime microphone STT lane.

Failures stay clear. Batshit does not silently fall back from one voice provider to another.

In Voice Settings and Agent Settings, the lane map separates Transcribe, Voice Mode STT, Reply Voice, and Runtime. Model-row badges label the selected lane as realtime microphone, recorded turn, recorded audio, batch TTS, realtime TTS, or unavailable, so uploaded-audio providers don't look like continuous-listening ones.

## Batch vs realtime TTS

Batch TTS waits until the assistant message is done, then creates one audio response. Direct realtime TTS streams stable chunks while the assistant is still responding. Fish Audio and Inworld are the direct realtime TTS paths Batshit owns for launch.

The difference matters:

- Batch TTS is simpler and works well for many providers.
- Realtime TTS can feel faster and more conversational.
- Realtime TTS has stricter setup and more moving pieces.
- Goons can lip sync to both, but the timing path differs.

Voice Settings can also keep italic narration silent while leaving it readable in chat. Agents can inherit that global choice or override it in Agent Settings -> Voice. The setting applies to Batshit-owned TTS paths, including direct realtime TTS and LiveKit Bridge reply playback. Voice Settings also has per-TTS-engine prompts for built-in and BYO providers, so an engine that supports special expressive syntax can teach the agent how to write spoken replies for that provider only. True speech-to-speech presets are different because the voice model owns listening and speaking as one session.

For 3D Goons, Inworld is the strongest realtime Premium lip-sync lane right now because it sends provider-native phoneme/viseme timing while audio streams. Batshit uses those timestamps directly for live mouth shapes when 3D Goon Lip Sync is set to Rhubarb WASM / the Premium viseme lane, so it does not wait for Rhubarb WASM analysis before first audio. Fish realtime TTS can keep live mouth timing aligned through streamed audio/text timing, but it does not currently provide the same provider-native mouth-shape detail.

Rhubarb WASM remains the completed-audio Premium analyzer for non-provider-viseme playback. That means it is useful for batch TTS and replay/precomputed analysis, but it is not Batshit's preferred realtime path because it needs audio to finish before analysis can run.

## Voice Mode

Voice Mode is the two-way speech experience from the chat bar. It can listen through Browser STT or a configured realtime STT lane, accept typed or system-dictated composer text through Text Input while still speaking replies, stop active speech when you start talking (where the lane supports interruption), and speak assistant replies when TTS is enabled for that send.

Voice Mode has separate settings from normal uploaded-audio transcription — the model used to "transcribe this uploaded clip" is not automatically the model used for realtime microphone Voice Mode.

Two input modes:

- **Mic STT** — Batshit listens through the selected Voice Mode STT lane.
- **Text Input** — you type or use system dictation in the composer and send normally; Batshit still treats the turn as Voice Mode for spoken replies and Goon behavior.

When the selected Voice Mode STT model records one spoken turn at a time, Auto Listen starts the next recording automatically and sends after a quiet pause, while Manual Turn lets you start each turn yourself. Continuous microphone Voice Mode needs Browser STT, Deepgram Flux, or a proven realtime BYO/local WebSocket engine. The [voice settings guide](voice-settings.md) covers the button states and turn behavior in detail.

## LiveKit

LiveKit is a realtime voice runtime — not a TTS engine and not an STT engine. Use it for room-based realtime audio, sidecar agents, and future speech-to-speech paths. It's optional and more advanced than normal direct TTS/STT.

LiveKit Bridge is not true speech-to-speech by itself: bridge mode still uses Batshit's selected Voice Mode STT and Reply Voice lanes. True speech-to-speech comes from a supported LiveKit-enabled model preset. Native Mac/Linux users can install a managed local LiveKit runtime from Voice Settings; Docker users can use the optional `livekit` profile. See the [voice settings guide](voice-settings.md) for setup.

## Voice engines

Voice Settings has a Voice Engines area for TTS prompts, STT provider status, bring-your-own or local engines, and voice runtimes. Use Installed Engine Controls when you have an existing local or remote speech service, want Batshit to health-check it, want to save defaults (model, voice, language, clone support), or want a managed local runtime to start with Batshit where that's supported.

Mac app Batshit integrates host-local runtimes more naturally. Docker Batshit is more contained and explicit about what runs inside the core stack versus an add-on, host operator, or external service — including the rule to save an engine disabled, health-check it, then enable it. The [voice settings guide](voice-settings.md) has the Docker URL details.

## Voice clones

Voice Studio can save cloned voice profiles where the selected provider or BYO engine supports the required clone behavior. Clone-capable local engines may need a reference audio file path the engine can read; in Docker, host-local engines need the reference sample stored on the host through the approved operator path, not only inside the app container.

Treat voice clone files as sensitive. A voice sample can identify a person and may be hard to revoke once shared.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| TTS says the provider isn't configured | Missing API key, model, voice, or engine health. | Settings → API Keys and Voice Settings. |
| Fish realtime TTS fails with a missing voice | Fish needs a selected Fish voice/reference voice. | Voice Settings -> Text-to-speech -> Voice. |
| Fish realtime TTS buzzes or repeats syllables | Fish audio chunks are arriving unevenly, or Fish chunk length was set too low for the current connection/runtime. | Use the default Fish chunk length or raise it in advanced TTS options. |
| Voice Mode starts but doesn't use cloud STT | The realtime STT lane isn't configured or launch-supported. | Voice Mode STT settings and provider readiness. |
| Voice Mode records one turn at a time | The selected Voice Mode STT model is a recorded-turn lane, not continuous microphone STT. | The Voice Mode STT model badge; use Browser, Deepgram Flux, or a proven realtime engine for continuous listening. |
| Docker local engine health fails | The saved URL uses browser `localhost` from inside the app container. | Try `host.docker.internal` for server-side Docker calls. |
| LiveKit appears unavailable | LiveKit is optional and needs a configured runtime. | Native: the Voice Runtimes LiveKit Install button. Docker: the LiveKit profile. External: saved LiveKit credentials. |

## Related docs

- [Voice settings](voice-settings.md)
- [3D Goons](../goons/overview.md)
- [Primary Agents](../primary-agents/overview.md)
- [Group Chat](../groups/overview.md)
- [Security and trust](../security/overview.md)
