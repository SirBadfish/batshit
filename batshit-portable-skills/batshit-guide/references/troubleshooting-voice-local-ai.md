# Voice and Local AI troubleshooting

Voice and Local AI often fail for the same reason: Batshit is calling a service from a different place than the browser is.

Start by identifying:

- Mac app/source-checkout Batshit or Docker Batshit
- cloud provider or local/BYO engine
- browser microphone lane or server-side request
- host service, sidecar service, or remote service

## TTS doesn't play

Check that:

- TTS is enabled for the current send or voice control.
- The selected TTS provider has a saved key if it needs one.
- The selected model/voice exists.
- The browser is allowed to autoplay/play audio after user interaction.
- The provider didn't return a visible error.
- If using an agent override, the agent voice profile is valid.

Try a small Voice Studio preview before testing a full agent reply.

## Fish realtime TTS fails

Fish realtime TTS needs a Fish API key and a selected Fish voice. If the error mentions a missing voice, choose the Fish voice/reference voice in Voice Settings or select a voice profile that supplies it.

Docker doesn't change Fish's public API. A missing voice is not a Docker networking problem.

## Voice Mode doesn't hear the microphone

Check browser microphone permission, the correct input device, that Voice Mode Input is set to Mic STT (not Text Input), that another app isn't holding the microphone exclusively, that browser STT is available if using the browser lane, and that the selected realtime STT lane is launch-supported.

Browser STT depends on browser/platform behavior. If it's unavailable, use a supported cloud realtime lane such as Deepgram Flux or a proven BYO/local realtime WebSocket engine.

## Voice Mode records one turn at a time

If Voice Mode records one spoken turn at a time, the selected Voice Mode STT model is probably labeled `Recorded turn`. That's expected for uploaded-audio providers like Fish ASR or non-realtime local Whisper engines: Batshit records one spoken turn, sends that audio to the selected STT provider, then speaks the reply with the selected TTS provider.

With Auto Listen, Batshit starts the next recorded turn automatically after the reply, shows voice activity while you speak, then stops and sends after a quiet pause. With Manual Turn, click the Voice button to start each recorded turn and click again to stop and send. Use the Voice Mode pill above the ChatBar to end the session.

If a realtime or LiveKit setup hears you but no words appear while you speak, the STT engine may be final-only — Batshit shows microphone activity during the turn and adds the user message when the final transcript arrives.

For continuous microphone listening, choose Browser STT, Deepgram Flux, or a BYO/local realtime STT engine with a proven WebSocket contract.

## Deepgram realtime Voice Mode fails

Check that the Deepgram API key is saved, the key has permission to mint short-lived tokens, the realtime STT provider is set to Deepgram, the browser can open WebSocket connections, and no network/proxy is blocking Deepgram.

A key that works for recorded/uploaded-audio transcription may still fail realtime token minting if its permissions are too narrow.

## A realtime STT lane is listed but not launch-supported

Some providers may appear in configuration or future-provider notes before their full realtime microphone path is launch-supported. Use the lanes Batshit labels as ready, and expect unavailable lanes to fail clearly instead of silently swapping providers. OpenAI, ElevenLabs, and Mistral realtime STT models are tracked as future live bridge candidates, but they are not current launch-supported realtime microphone lanes.

If a provider says realtime isn't launch-supported, use Browser STT, Deepgram Flux realtime STT, a proven BYO/local realtime STT engine with a WebSocket contract, or uploaded/recorded-audio transcription for non-realtime workflows. Don't expect a recorded-audio provider to automatically work as a continuous microphone provider.

## Local voice engine health check fails

Native install: verify the engine process is running, open its health URL directly, confirm the base URL and paths in Settings → Voice → Voice Engines → Installed Engine Controls, and save disabled first → health-check → then enable.

Docker install: a host service URL usually needs `host.docker.internal`, a same-Compose sidecar URL uses its service name, and browser-direct realtime STT WebSockets may need `localhost` because the browser sends microphone audio. Examples:

```text
http://host.docker.internal:8077
ws://localhost:8078
```

Don't swap HTTP and WebSocket caller URLs blindly.

## Local voice engine works natively but not in Docker

The engine probably runs on the host and Docker is trying `localhost` from inside the app container. Use:

```text
http://host.docker.internal:<port>
```

For browser-direct realtime STT, keep the WebSocket browser-reachable:

```text
ws://localhost:<port>
```

For LiveKit bridge-mode BYO realtime STT, the sidecar uses the Docker-reachable host URL instead.

## Cloned voice preview fails in Docker

Clone-capable host-local engines often expect `ref_audio` to be a file path on the host. In Docker, the app container's private `/root/.batshit` path isn't readable by a host speech engine.

Fix: use the normal Docker launcher so the authenticated host operator is configured, recreate the clone/reference profile if it was created with a bad path, verify the engine can read the saved reference file path, and run one preview before assigning the clone to chat.

## Goon mouth doesn't move

Check that TTS audio actually plays, the Goon Dock is open and the Goon is loaded, the Goon has usable mouth blendshapes, Voice Settings → 3D Goon Lip Sync is set, and the current provider supports the selected lip-sync path. Completed-audio playback needs a file Rhubarb WASM can analyze; Inworld realtime TTS can use provider phoneme/viseme timing live.

If only one Goon fails, it's likely a Goon rig/morph issue. If every Goon fails, it's likely a voice playback/lip-sync setting issue.

## LiveKit doesn't start

LiveKit is a Voice Runtime, not a TTS/STT engine.

Native local LiveKit: open Settings → Voice → Voice Engines → Voice Runtimes and use **Install**, or **Update & Restart** when Batshit reports that its managed copy is stale. If it still fails, check whether ports `7880`, `7881`, or `7882/udp` are already in use. Batshit only restarts a server process it launched itself; stop any externally owned server before applying a managed server update. If the installer says the `LIVEKIT_AGENT_SOURCE_ROOT` source package or npm CLI is missing, reinstall or rebuild Batshit because the packaged managed runtime is incomplete. If voice session start says no LiveKit agent name is configured, update/rebuild Batshit; managed native dispatch should default to `batshit-livekit-agent`.

Docker local LiveKit:

```sh
./start-docker.sh --profile livekit
```

Advanced direct Compose:

```sh
docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent
```

Check that:

- `LIVEKIT_URL` is browser-facing, usually `ws://localhost:7880`
- `LIVEKIT_INTERNAL_URL` is app-container-facing, usually `ws://host.docker.internal:7880`
- `LIVEKIT_AGENT_LIVEKIT_URL` is sidecar-facing, usually `ws://livekit:7880`
- API key/secret match across app, server, and agent worker
- LiveKit ports aren't already in use
- native LiveKit will refuse `7880` if Docker already owns that port — stop the Docker LiveKit container/profile or choose a different saved LiveKit URL before starting the native runtime
- native local server startup must not inherit Batshit Redis env vars such as `REDIS_HOST`

External LiveKit: save URL/API credentials in Settings → API Keys → Voice Runtime, use `wss://` and proper TLS for real remote deployments, and check firewall/TURN/WebRTC networking if audio connects but media doesn't flow.

## Local AI models don't appear

Check that the program is running, its own model list works, it's enabled in Settings → Local AI, the Base URL and OpenAI path are correct, Docker uses `host.docker.internal` for host programs, and a remote URL is reachable from Batshit.

Common defaults:

| Program | Native URL | Docker-to-host URL |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | `http://host.docker.internal:11434` |
| Docker Model Runner | `http://localhost:12434` | `http://host.docker.internal:12434` |
| LM Studio | `http://localhost:1234` | `http://host.docker.internal:1234` |
| llama.cpp | `http://localhost:8080` | `http://host.docker.internal:8080` |
| vLLM | `http://localhost:8000` | `http://host.docker.internal:8000` |
| SGLang | `http://localhost:30000` | `http://host.docker.internal:30000` |
| oMLX | `http://localhost:8000` | `http://host.docker.internal:8000` |

oMLX and vLLM share port 8000 by default. If you enable both, Batshit warns you and names them — change the port on one of them and update the Base URL to match.

If the program answers but Batshit reports a 401, it wants an API key. Save it on that program's card in Settings → Local AI, or under Settings → API Keys — same value either way.

## Local AI text works but images fail

First check the selected model preset. If its Vision capability is off, Batshit treats it as text-only and blocks image clips before calling the program — switch to a vision-capable preset or remove the image clip.

Then check image transport. Automatic sends local image clips as structured data URLs when possible (better for some local vision models). Force URL makes the program fetch images through a URL, which needs an image base URL the program can reach. For Docker, a forced image URL base often needs:

```text
http://host.docker.internal:5600
```

If the runtime rejects image URLs, switch back to automatic. If it can't handle data URLs, use Force URL and make the URL reachable. Batshit doesn't silently retry with the other transport — fix the selected setup.

## Local AI tool calls fail

Many local models don't support tool calling well. Prove plain text chat works first, use a model known to support tools, enable tools on the preset only after basic chat works, test one harmless tool call, and use a stronger hosted model if the local model can't reliably call tools. Tools default off for local presets unless explicitly enabled.

## Local AI works in n8n but not Batshit

n8n and Batshit may be calling different URLs or using different model/provider nodes. For n8n Workflow Subagents, configure the local provider inside n8n. For `API` Primary Agents, configure Settings → Local AI and a Batshit model preset. These are separate setup paths.

## Backup restore didn't restore voice or Local AI runtime

Batshit backups can restore settings and references. They don't include Local AI model weights, the programs themselves, voice engine installs, local TTS/STT model files, or LiveKit servers/workers.

After restore: reinstall or restart the external runtime, reconnect the URL in Batshit, re-enter provider keys if the backup excluded secrets, run health checks, and run one real text/TTS/STT test before trusting the restored setup.

## Safe recovery order

When voice or Local AI is broken, test in this order:

1. The runtime's own app/CLI works.
2. Batshit health/status check passes.
3. Batshit lists models/voices.
4. One tiny text or preview request works.
5. One real chat or transcription works.
6. Then test advanced features: tools, vision, cloned voices, Goons, or Voice Mode.

Small proofs save a lot of time.
