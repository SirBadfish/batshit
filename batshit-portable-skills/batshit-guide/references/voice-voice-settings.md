# Voice, TTS, and STT

This is the hands-on voice guide. For the mental model — the three ideas, the lane taxonomy, how Voice and Goons fit together — see [Voice and Goons](overview.md).

Batshit voice has three separate ideas:

- **TTS** — text-to-speech, where Batshit speaks an assistant reply.
- **STT** — speech-to-text, where Batshit transcribes audio into text.
- **Voice Mode** — a phone-style conversation flow with turn-taking and interruption. It can listen through Voice Mode STT, or use Text Input so you type/use system dictation while Batshit still speaks replies. Mic STT is continuous only when the selected Voice Mode STT lane supports realtime microphone input; otherwise it records one spoken turn at a time.

Keeping them separate makes setup easier. A provider can be great for one lane and not launch-supported for another.

## Where voice settings live

Open Settings → Voice. The main areas:

- **Global Voice Settings** — default TTS, STT, Voice Mode, lip sync, and runtime choices.
- **Voice Studio** — voice clone/reference sample workflow.
- **Voice Engines** — per-engine advanced TTS/STT settings, TTS engine prompts, STT provider status, BYO/local/external engine records, and voice runtimes.
- **Voice Runtimes** — LiveKit lives here as a realtime voice runtime, not a TTS/STT engine.

Agents can also have voice overrides. An agent can speak with one provider, transcribe uploaded audio with another, and use a separate realtime STT lane for Voice Mode. Advanced engine settings such as language, speed, sample rate, chunk size, and provider-specific options are global per engine in Voice Engines, so you set them once instead of retyping them every time you switch providers.

## Voice Settings lane map

Global Voice Settings separates the lanes so they're easy to audit:

- **Transcribe** — composer dictation and uploaded-audio transcription.
- **Voice Mode Input** — Mic STT or Text Input for the ChatBar Voice button.
- **Turn Mode** — Auto Listen or Manual Turn when Direct Voice Mode uses recorded-turn STT.
- **Judge Juice: Quick Actions** — off by default. With it on, a spoken turn that starts with the wake word and asks Batshit itself for something small ("Yo, stop", "Yo, hang up", "Yo, open the dock", "Yo, open the voice settings") is done at once, without the agent. **Require Wake Word** and **Wake Word** ("Yo" by default) sit under it. See [Judge Juice](../judge-juice/overview.md#quick-actions-from-speech-one-switch-in-voice-settings).
- **Voice Mode STT** — the listener used by the ChatBar Voice button.
- **Reply Voice** — the TTS provider used for spoken assistant replies.
- **Runtime** — Direct Voice Mode or LiveKit Bridge.

The Voice Mode Input selector controls whether Batshit listens through the Voice Mode STT provider or accepts composer text. Text Input is useful when you already use Apple dictation or another system-wide dictation tool — the assistant still speaks replies, and the agent still receives Voice Mode context.

The Voice Mode STT model selector labels the selected listening lane as `Realtime mic`, `Recorded turn`, `Realtime candidate`, or `Unavailable` in both Global Voice Settings and Agent Settings. A recorded-turn model can still be useful in Voice Mode: with Auto Listen, Batshit records the next turn automatically when the reply is done, shows activity while you speak, then stops and sends after a quiet pause. With Manual Turn, you click the Voice button to start each recorded turn and click again to stop and send. Manual Turn is unavailable for realtime mic providers, LiveKit Bridge, and Text Input; Settings shows when that's the case.

For the Transcribe mic button, Browser STT can show words in the composer while you speak. Recorded STT providers show voice activity while you speak, then drop the final transcript in the composer after you stop. Transcribe Mode never sends automatically.

If the current agent has voice overrides, Settings shows that before the global defaults. The ChatBar Voice button checks the agent's runtime, Voice Mode STT, and TTS choices first, then falls back to Global Voice Settings.

## Advanced engine settings

Open Settings -> Voice -> Voice Engines to tune advanced settings for each engine.

- **Text-to-Speech Engines** — TTS prompt guidance plus engine-level speech settings such as speed, volume, language, format, sample rate, chunk length, or other provider-specific controls.
- **Speech-to-Text Engines** — STT language and provider-specific transcription settings.

These settings belong to the engine itself, not to one agent. If you set Google Gemini/Whisper/Deepgram/OpenAI language to English, that setting stays attached to that engine whether you use it globally, on an agent, in Transcribe mode, or after switching away and back.

## TTS: speaking replies

TTS plays assistant text as audio. Launch-facing behavior:

- OpenAI, ElevenLabs, Deepgram, Google/browser-style lanes, Fish Audio, MiniMax, MiMo, Alibaba Cloud, Inworld, Cartesia, Async, StepFun, Azure Speech, and BYO engines appear according to configured provider support and saved keys.
- Fish Audio and Inworld are the direct realtime TTS paths Batshit currently owns.
- Other built-in/BYO/local providers should be treated as batch TTS unless Batshit has a proven streaming adapter for that provider.
- Deepgram offers Aura on Batshit's `/v1/speak` batch path and Flux voices on the separate `/v2/speak` batch path. Flux speed, expressivity, output format, and model-improvement opt-out controls live in Voice Engines. Batshit does not label Flux as realtime TTS until its separate WebSocket lifecycle and interruption path is implemented and proven.
- TTS model rows show `Batch TTS` or `Realtime TTS` based on Batshit's actual runtime path, not only what a provider's public docs advertise.
- Voice pickers use built-in static voice lists where the provider has one, and provider APIs where voices are account/workspace-specific. Mistral lists saved Audio Voices when a key is configured, while still allowing a manual `voice_id`.

The `Italic narration` switch controls whether italic text is spoken. When it is set to `Silent`, italic Markdown or HTML stays visible in chat but is removed from Batshit-owned TTS playback. Agents can use the global choice or override it in Agent Settings -> Voice. This applies to normal reply TTS, direct realtime TTS, replay/playback, previews, and LiveKit Bridge reply playback. True speech-to-speech model presets are separate voice sessions, so they use the preset's own voice/model instead of this TTS setting.

### TTS engine prompts

Some TTS engines understand special expressive syntax or need provider-specific writing rules. Open Settings -> Voice -> Voice Engines -> Text-to-Speech Engines, then click Edit on a provider's prompt row to add a prompt for any built-in or BYO TTS provider.

That prompt is given to the AI only when Batshit is about to speak a reply with that exact TTS provider. It can tell the agent which cues to use, which tags to avoid, how short directions should be, or how to handle pronunciation. It does not change saved chat text, provider keys, STT transcription, or 3D Goon emotes.

Fish realtime TTS needs a Fish API key and a selected Fish voice in Voice Settings (or a `voiceId` supplied by the caller). If Fish fails with a missing-voice message, the network usually isn't the problem — choose the Fish voice/reference voice in the Voice field first. Fish realtime playback buffers the first two audio chunks and defaults to a smoother chunk length so playback does not starve when provider chunks arrive unevenly. If you manually lower Fish chunk length for speed and hear buzzing or repeated syllables, raise it again. Fish can keep Goon mouth timing stretched to the streamed audio duration, but it does not currently send provider-native viseme mouth shapes.

Inworld realtime TTS needs an Inworld API key and a selected Inworld voice in Voice Settings. Batshit calls Inworld's realtime TTS endpoint directly and keeps ownership of chat context, tools, Zips, message storage, and playback events. When 3D Goon Lip Sync is set to Rhubarb WASM / the Premium viseme lane, Batshit keeps Inworld's OVR-style phoneme/viseme detail through playback and adapts it to the active Goon's authored mouth profile instead of flattening it early or waiting for Rhubarb WASM analysis.

MiniMax, MiMo, Alibaba Cloud, and StepFun reuse their pay-as-you-go saved API key for direct model presets and speech. MiniMax Token Plan and MiMo Token Plan are separate key rows; eligible MiniMax/MiMo speech prefers subscription quota when the plan key is present. The MiMo Token Plan is paused for now (see [API keys and models](../providers/api-keys-and-models.md#paused-plans)): while its key is saved, MiMo speech says so instead of switching to the pay-as-you-go key. Inworld, Cartesia, Async, and Azure Speech are TTS-only rows in Settings -> API Keys; Inworld is TTS-only but supports Batshit-owned direct realtime TTS, while Cartesia, Async, and Azure Speech remain batch TTS lanes in Batshit until direct streaming adapters land. Azure's current Batshit lane is REST batch TTS and regional voice listing; provider viseme/lip-sync events need a future Azure Speech SDK bridge.

## STT: transcribing audio

Batshit separates normal transcription from phone-style Voice Mode.

**Recorded or uploaded-audio transcription** uses the selected STT provider after the audio is captured. It can use cloud providers or a proven local/BYO engine, and it does not automatically become a continuous realtime microphone lane.

Google Gemini 3.5 Transcribe is available in that recorded lane. It can auto-detect language or use a BCP-47 language hint, and Voice Engines exposes Verbatim/Smart mode, custom vocabulary, speaker diarization, and word timestamps. Smart mode cannot be combined with diarization or word timestamps; custom vocabulary cannot be combined with either. Batshit uploads the recording through Google's Files API, transcribes it through the Interactions API, and deletes the temporary Google file afterward. This does not enable the separate Gemini live-transcription model.

MiMo V2.5 ASR is available in the same recorded/uploaded lane. Batshit converts supported captures to WAV, sends only `mimo-v2.5-asr`, and offers automatic, Chinese, or English recognition; Xiaomi's model also covers major Chinese dialects and Chinese-English code switching. This is not a realtime microphone session.

**Realtime microphone Voice Mode:**

- Browser STT is the free/default lane when available in your browser.
- Deepgram Flux is the first launch-supported cloud realtime STT Voice Mode lane.
- BYO/local realtime STT is supported only when the engine record declares a proven WebSocket contract.
- OpenAI realtime STT may appear as a planned/candidate lane, but it isn't a launch-supported realtime microphone lane until Batshit proves the full live transport path.
- ElevenLabs Scribe v2 is available for recorded/uploaded-audio STT. Scribe v2 Realtime is tracked as a future live bridge, but it is not selectable as a working realtime Voice Mode lane yet.
- Fish supports recorded/uploaded-audio ASR, not a launch-supported realtime microphone lane.
- Mistral Voxtral STT is available for recorded/uploaded-audio transcription. Voxtral realtime transcription is tracked as a future live bridge, but it is not selectable as a working realtime Voice Mode lane yet.

Voice Mode never silently borrows the normal Transcribe STT provider. If the selected realtime lane isn't ready, Batshit fails clearly or falls back only to the explicit browser lane.

## Saved choices and lip sync

Voice Settings waits for your saved settings to load. If they cannot be read, use **Retry** before editing. The Goon Dock's **Lip Sync Lab** follows the same rule and saves the global mode and analyzer while keeping the independent blend and other Voice choices. Voice Settings saves lip-sync fields only when you change them; after a save, untouched lip-sync controls follow the saved answer while your later edits stay in the form.

## Voice Mode button states

The ChatBar Voice button controls the current voice moment, not the whole session by itself:

- **Green** — Voice Mode is ready or listening.
- **Red** — Batshit is recording your spoken turn.
- **Amber with a pause icon** — the assistant is speaking; click to stop the spoken reply and keep Voice Mode on.
- A small Voice Mode pill above the ChatBar shows the active mode and holds the End control. The same pill appears for Direct Voice Mode and LiveKit sessions.

For recorded-turn STT, Auto Listen is the default: it shows voice activity instead of preview transcript words, and the selected Voice Mode STT provider is the final transcript source. Manual Turn is available when you'd rather start each turn yourself. Realtime STT only shows words while you speak when that engine sends partial transcripts; final-only realtime engines and LiveKit bridge sessions show microphone activity, then the final user message when transcription completes.

For Text Input Voice Mode, click the Voice button once, type or use your system dictation shortcut, then send normally. Batshit keeps Voice Mode on for spoken replies until you use the pill's End control.

## Browser Voice Mode

The simplest path:

1. Open Settings → Voice.
2. Use browser STT for Voice Mode, or leave Voice Mode on its default browser lane.
3. Allow microphone permission in your browser.
4. Use the ChatBar voice control.
5. Test with a short sentence.

Browser STT quality and availability depend on the browser and platform. It's free, but not identical across every computer.

## Deepgram realtime Voice Mode

Deepgram Flux is the first launch-supported cloud realtime STT lane.

1. Save a Deepgram API key in Settings → API Keys.
2. Pick Deepgram for Voice Mode realtime STT in Settings → Voice.
3. Confirm the selected model is a realtime-capable Deepgram lane.
4. Start Voice Mode and allow microphone permission.
5. Speak a short test sentence.

Deepgram realtime token minting needs a key with enough permissions for Batshit to create a short-lived browser token. A narrower key can work for recorded/uploaded transcription while failing realtime Voice Mode.

## Local and BYO engines

BYO means bring your own — a local or external service Batshit calls through an HTTP or WebSocket contract. Use Settings → Voice → Voice Engines → Installed Engine Controls → Connect Existing when the engine already runs somewhere.

Recommended flow:

1. Start the engine outside Batshit.
2. Confirm the engine's own health endpoint works.
3. In Batshit, choose Connect Existing.
4. Enter a clear name, engine ID, base URL, capability choices, request format, and paths.
5. Save it disabled first.
6. Run Health Check.
7. Run one real synthesis or transcription test.
8. Enable the engine only after the test passes.

If Installed Engine Controls says a saved engine can't be read, its saved settings are in a form this Batshit doesn't know, usually because a newer Batshit saved them (after going back to an older version, or restoring a backup from a newer one). Batshit keeps that engine's settings exactly as they are and won't edit, use, or delete it. Your other engines and your chats work as usual. The voice pickers still list that engine, marked "Saved settings can't be read", and speaking with it shows an error. In Docker, while an engine can't be read, Batshit stops none of your engines when it shuts down, so an engine set to Stop with Batshit keeps running until you stop it. If a newer Batshit saved it, updating Batshit makes it readable again.

For Mac app or source-checkout Batshit, local engines can usually use normal `localhost` URLs. For Docker Batshit, server-side TTS and uploaded-audio STT usually need `http://host.docker.internal:<port>`, while browser-direct realtime STT usually needs a browser-reachable WebSocket like `ws://localhost:<port>`. LiveKit bridge-mode STT starts from the LiveKit sidecar, so the same host service is reached through `host.docker.internal` for that path.

### Start with Batshit and Stop with Batshit

Each local engine Batshit can launch has two switches in Settings → Voice → Voice Engines → Installed Engine Controls:

- **Start with Batshit** launches the engine after the app boots.
- **Stop with Batshit** stops it when Batshit shuts down. It is **on** by default, so an idle engine stops holding memory (a large Whisper model can hold several gigabytes). Turn it off to keep the engine running all the time, which makes the next start instant because the model stays loaded.

Batshit only ever stops the process it started. It records the process it launched and when, and before stopping anything it checks that the running process is still that one, so an engine you started yourself is never touched. A crash or a force quit cannot stop anything, so an engine can survive that way whatever the switch says.

If one of those launch records cannot be read (it is damaged, or Batshit has no permission to read it), Batshit stops no engine on that quit and changes no record, because the damaged one might hold an engine's **Stop with Batshit** off. The log names the file. Once the engines have stopped (restarting the computer stops them), fix or remove that file; the next quit then works as usual. Starting an engine whose launch record cannot be read fails too, and says which file.

On macOS 27 and later, an engine left running with **Stop with Batshit** off shows as a light gray dot under Batshit's Dock icon after you quit ("Running in Background"), because Batshit started it. That is expected; the dot goes away when the engine stops.

Some engines share one running program. Several MLX engines, for example, can run on the same shared `mlx_audio.server` on one port. Batshit stops a shared program only if every engine that uses it has **Stop with Batshit** on; if any one of them has it off, the program keeps running for all of them.

Engines you added with **Connect Existing** have no **Stop with Batshit** switch, because Batshit never started them. Their info menu says so.

In Docker, Batshit starts and stops host engines through its helper program on your computer (the host operator that `./start-docker.sh` starts). When the Docker app shuts down, the helper stops the engines whose switch is on. This works on macOS and Windows with the current helper. The switch appears once `./start-docker.sh` has updated that helper; until then, it stays hidden and the info menu says why. On Windows, a launcher that exits before the helper identifies its children can leave an engine running. When it detects that uncertainty, the helper reports an incomplete stop and keeps the launch record. If it could not identify any process when the engine started, it leaves a running engine alone and tells you why; once that engine is gone, it removes the record. If the helper cannot read the Windows process list while applying engine choices, it stops no engines and reports an error. A child that detached before it was observed may still need to be stopped manually.

Batshit-managed local engines should keep their own files under `~/.batshit/installs/<engine-id>/`. For Hugging Face-backed engines, Batshit uses a per-engine cache such as `~/.batshit/installs/<engine-id>/hf-home` by default, so deleting that managed engine's local files can remove its downloaded weights too. Reusing an existing shared Hugging Face cache is allowed, but it should be an explicit choice because Batshit will not own or delete that shared folder automatically.

When you delete an engine with **Delete local files too**, Batshit first stops the engine if it started it and it is still running, unless another engine still uses the same running program. In that case, and when another Batshit on this computer (Batshit in Docker included) has also run that engine, Batshit leaves the engine's files in place and tells you which folders it left. It never stops what another Batshit started. If Batshit cannot stop it, or cannot read a launch record that might belong to it, it keeps the engine's files and tells you why, so the engine is never left running from a deleted folder. In Docker, an engine installed on the computer that runs Docker keeps its files on that computer, where Batshit in Docker cannot delete them: Batshit tells you which folder it left, so you can delete it yourself once the engine has stopped.

## Docker voice boundary

Cloud voice providers work from Docker with saved keys. Docker Batshit does not install arbitrary host-style local speech engines from inside the core app container. Launch-supported Docker choices:

- connect to an already-running engine
- start a saved Batshit-managed host-native runtime through the authenticated host operator when that record already exists
- use a specifically approved Docker sidecar/profile when one exists

Start Docker with `./start-docker.sh` after updating to prepare the host voice helper. Host engine starts use the engine's saved launch recipe. A direct Docker Compose start still works, but starting a host voice engine reports a setup error if the launcher's private voice key is missing.

Voice engines are a connect-existing runtime family in the Docker add-on catalog. Start/stop refuses generic voice-engine containers until a specific engine sidecar has pinned versions, volumes, health checks, secrets, restart behavior, backup boundaries, and real TTS/STT proof.

Clone-capable host-local engines need one extra rule: reference audio paths must be readable by the engine. Docker Batshit stores cloned-voice reference samples on the host through the authenticated operator for host-local engines — the app container's private `/root/.batshit` path is no use to a host speech engine.

## LiveKit voice runtime

LiveKit is an optional realtime voice runtime. It is **not** required for normal TTS, not a TTS provider, not an STT provider, and not a paid voice tier.

Use it for room-style realtime voice, bridge-mode STT, and supported speech-to-speech model presets when the LiveKit server and Batshit sidecar are configured.

LiveKit Bridge is not the same as true speech-to-speech. Bridge mode still uses Batshit's selected Voice Mode STT and Reply Voice lanes; true speech-to-speech comes from a supported LiveKit-enabled model preset where the provider/model owns listening, reasoning, and speaking together. When LiveKit Bridge is active, the ChatBar shows the same floating Voice Mode pill and End control used by Direct Voice Mode. Some LiveKit bridge STT paths return only a completed turn instead of partial words, so the composer may show microphone activity while you speak and then add the final user message at the end.

Native Mac/Linux users can install the local LiveKit runtime from:

```text
Settings → Voice → Voice Engines → Voice Runtimes → LiveKit → Install
```

The install button downloads the LiveKit Server version tested with your Batshit build, installs the matching Batshit sidecar under the managed runtime folder, saves local Voice Runtime credentials when needed, and starts both services. If a later Batshit build carries a newer tested runtime, this row shows **Update available** and changes the action to **Update & Restart**. Batshit restarts only the LiveKit server and sidecar it started itself: if another Batshit on this computer started the running one, or also uses it, or you started it yourself, the row shows why it did not restart, and it keeps running. **Start with Batshit** also refreshes stale Batshit-managed sidecar code before auto-start; it does not chase untested upstream releases on its own. The LiveKit row has its own **Stop with Batshit** switch, on by default, which stops the managed LiveKit server and sidecar when Batshit shuts down. Turn it off to leave both running. A change applies to a LiveKit that is already running; if it cannot reach it, the row says so until LiveKit restarts. If another Batshit on this computer already runs the LiveKit server, this Batshit uses that server and keeps its own Stop with Batshit choice for it. The LiveKit agent serves the Batshit that started it. If another Batshit’s agent is running here, or Batshit cannot tell whether it is its own, the row tells you what to stop or check first. If this Batshit's own agent was started by an older Batshit version, the row asks you to press Start once, which restarts it. Before starting a voice session, Batshit checks that its own LiveKit agent is running here and refuses if it cannot confirm that. If that Batshit restarts LiveKit, the row tells you to start LiveKit here again so the choice is kept. If an older Batshit started that LiveKit, the row asks you to update that Batshit and restart LiveKit there first. In Docker the LiveKit add-on owns its own lifecycle, so that switch does not apply.

Docker users can start the local LiveKit add-on with:

```sh
./start-docker.sh --profile livekit
```

Advanced Compose path:

```sh
docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent
```

You can also connect an external LiveKit server or LiveKit Cloud by saving the LiveKit URL, API key, and API secret in Settings → API Keys → Voice Runtime.

## Voice clones

Voice Studio lets you create saved voice clone profiles when the chosen provider or BYO engine supports it. Good clone hygiene:

- Use clean reference audio.
- Add or transcribe reference text when the engine benefits from it.
- Preview before using it in chat.
- Save the clone under a clear name.
- Assign the profile globally or per agent.

Not every TTS provider supports cloning. If cloning isn't available for a provider, Batshit won't pretend it is.

## 3D Goon lip sync

If you use 3D Goons, voice playback can drive mouth movement. Global lip-sync choices:

- **Shitty but Fast** — quick amplitude-based mouth movement with timing fallback.
- **Rhubarb WASM** — completed-audio mouth analysis in the browser. Inworld realtime TTS can still use its own phoneme/viseme timing live.
- **NVIDIA Audio2Face** — optional completed-audio full-face ARKit animation for compatible Advanced/GLB Goons. It needs Batshit's Docker bridge plus a separately installed and licensed NVIDIA Audio2Face-3D NIM v2.0 GPU runtime.

Direct realtime TTS does not wait for completed-audio analysis. Fish and Inworld realtime alignment can improve cue timing when provider timestamps are available. Inworld can also drive live Goon mouth shapes from its provider phoneme/viseme timing during realtime playback.

Audio2Face is an optional advanced lane, not part of Batshit's core install and not an NVIDIA runtime distributor. Start your licensed NVIDIA NIM separately, set its reachable gRPC endpoint in `.env.docker`, then start the `audio2face` bridge profile. Admin → Runtimes reports the bridge and NVIDIA NIM separately. If Audio2Face fails for a completed utterance, Batshit shows the failure and tries Rhubarb WASM; if Rhubarb also fails, it reports that and uses text timing. The first Audio2Face release is completed-audio/cache-first only, not realtime streaming.

Visual quality still depends on the avatar's authored mouth expressions. If timing is aligned but some shapes look too closed, too narrow, or generally awkward, check the Goon's Blender/VRM mouth morphs and `avatar.json` face-expression mapping before assuming the voice provider is wrong.

If a Goon's mouth doesn't move, check that a TTS playback event actually started, the Goon has usable mouth blendshapes, the Goon Dock is open and the Goon is loaded, and the selected lip-sync lane is supported for the current playback path.

## Group Chat voice

Batshit queues group playback so one agent speaks at a time, and each agent can have its own voice settings. If group voice sounds wrong, check each agent's voice profile, make sure only one live speaker is expected, and verify the selected TTS provider works for each agent outside Group Chat first.

## Safe voice rules

- Voice failures should be visible. Batshit doesn't silently switch providers.
- Realtime and batch voice support are different — don't assume a batch provider can do realtime microphone work.
- Italic narration only changes spoken playback. It does not hide or edit the chat message.
- If Voice Mode records one turn at a time instead of staying open, the selected Voice Mode STT lane is probably a recorded-turn provider. Auto Listen can still start the next recorded turn, but true live listening needs Browser STT, Deepgram Flux, or a proven realtime BYO/local WebSocket engine.
- Protect provider keys and secret-including backups.
- Don't expose local voice engines to the public internet without understanding the engine's auth and safety model.
- Keep LiveKit and local speech engines backed up through their own setup notes; Batshit backups store references/settings, not the full external runtime.

## Related docs

- [Voice and Goons](overview.md)
- [3D Goons and advanced packages](../goons/setup-and-packages.md)
- [Local AI](../local-ai/overview.md)
