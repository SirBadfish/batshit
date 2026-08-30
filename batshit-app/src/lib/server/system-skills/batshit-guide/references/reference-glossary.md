# Glossary

This glossary explains Batshit terms in plain English. It is written for first-time users and reviewer-friendly launch docs.

## A

### Agent

An AI assistant configured in Batshit. The main agent you chat with is a Primary Agent. A specialist called by another agent is a Subagent.

### Agent Browser

Batshit's browser automation runtime. Native installs can use the host runtime where configured. Docker installs use an optional sidecar with its own headless browser.

### Agent Use

Artifact setting that controls whether agents can discover and call a published Artifact as a runtime tool.

### AGPL-3.0-only

The GNU Affero General Public License v3.0 only. This is the planned Batshit core code license for public launch. It does not grant Batshit trademark or brand rights, and it does not turn user-created content into Batshit code.

### Alpha

Batshit's first public launch posture. Alpha means useful for early adopters, but still expected to have bugs and evolving docs.

### API Primary Agent

A Primary Agent that talks directly to model providers through Batshit's built-in provider path.

### API Subagent

A Batshit-managed direct-provider specialist that a compatible Primary Agent can call.

### Artifact

A persistent mini-app inside Batshit. Artifacts can be static, AI-powered, webhook-backed, n8n-backed, or panel-style front ends for external runtimes.

### Artifact Power Source

The setting that describes what powers an Artifact, such as Built-in AI, n8n Workflow, Custom Webhook, ComfyUI, HuggingFace, Gradio, or Static / No AI.

## B

### batshit-server

Batshit's helper service for uploads, retained helper tools, MCP transport, and related local/server capabilities. The launch-facing local browser port is `5600`.

### Batshit Internal Token

The internal service token used so Batshit, batshit-server, and trusted helper paths can trust each other. It is owned by the active runtime environment: root `.env` for source installs, Mac runtime config for the packaged app, and `.env.docker` for Docker. Provider keys are the normal user-entered secrets.

### Browser STT

Speech-to-text provided by the browser/platform. It is the free/default Voice Mode input lane, but behavior depends on browser support.

## C

### CLI

Command-line interface. In Batshit docs, `CLI` also means the Primary Agent type that runs a managed Codex or Claude Code path inside Batshit.

### CLI Primary Agent

A Primary Agent that uses a managed CLI agent while Batshit still owns chat history, Clips, Zips, tool rendering, and workspace UI.

### CLI Subagent

A one-shot managed CLI specialist that a compatible Primary Agent can call.

### CLI Tool

A saved local command or executable that Batshit exposes to agents with a structured manifest, input schema, boundaries, and test flow.

### Clip

A reusable file or media attachment stored in Batshit. Images, files, and Artifact-generated outputs can become Clips.

### Clip Vault

The place where saved Clips are managed and reused.

### Cloudflared

Cloudflare's tunnel tool. Batshit can use it for managed Clip tunnel URLs. In Docker it is an optional sidecar/profile, not part of the core app container.

### ComfyUI

A visual workflow runtime often used for image generation. Batshit can build ComfyUI-style Artifacts that call a reachable ComfyUI service through Batshit's proxy.

### Connect Existing

Setup shape where you already run a service, such as Local AI, ComfyUI, or a voice engine, and you give Batshit the URL and credentials it needs to reach it.

### Control Plane

The app-management side of Batshit, such as creating Artifacts, managing runtime add-ons, or saving CLI Tool records.

## D

### Deepgram Flux

The first launch-supported cloud realtime STT Voice Mode lane when Deepgram credentials with the right permissions are configured.

### Docker Batshit

Batshit running through Docker Compose. The core stack includes the app, batshit-server, and Redis. Optional services such as optional Docker n8n profile, LiveKit, Agent Browser, Cloudflared, and workers are explicit profiles or add-ons.

### Apple Container

Apple's local container system used by the Mac app as Batshit's default sandbox backend for agent command execution on supported Macs.

### Docker Sandbox

Batshit's isolated command-execution backend. In Docker installs it uses a first-party host operator path instead of mounting the host Docker socket into the app container.

### Dynamic Current Message

An ephemeral context block Batshit adds to the current user message before sending it to the agent. It can include Project path, file refs, tool discoverability, Subagents, Clips, Goon cues, and other current-turn context. It is not permanently stored as a normal message.

### Dynamic Tool Search

Batshit's search-then-use pattern for discoverable MCP tools, saved CLI Tools, published Artifact runtime tools, Fabric controls, and Agent Browser capabilities. The agent searches only when needed, then calls the selected result.

## E

### Engine Manager

The Voice Settings area for managing BYO TTS/STT engines and related local/external speech services.

### Episode

A natural stretch of conversation inside an Infinite Session (for example, one afternoon of work). Finished episodes graduate: they are summarized into the agent's memory while the original messages stay stored and searchable.

### Execution Viewer

Batshit's inspection panel for request and runtime evidence. Use it when you need to understand what an agent sent, received, or called.

## F

### Fabric Control

A Batshit-native app capability exposed to agents through a safe find/use contract. Artifact lifecycle actions and runtime add-on actions are examples.

### Fabric Fields

Typed fields inside an Artifact that Batshit can expose to agents as structured inputs.

### FBX-to-VRMA

An optional conversion path for Goon Motion Vault uploads. Native installs use an Admin-managed converter. Docker installs use the optional `fbx2vrma` worker profile.

### Fish Audio

One of Batshit's direct realtime TTS providers when a Fish API key and reference voice are configured.

## G

### Goon

A 3D avatar assigned to an agent. Goons can animate, emote, use scenes/outfits, and lip sync to speech.

### Goon Dock

The right-sidebar surface where the active Goon renders during chat.

### Goon Kitchen

The settings area for shared Goon moods, emotes, eye-contact profiles, and related reusable Goon behavior.

### Group Chat

A Batshit conversation where multiple Primary Agents can participate. Launch-facing Group Chat is for `API` and `CLI` Primary Agents.

## H

### Host Operator

A small host-side helper used by Docker Batshit for approved operations that cannot safely happen inside the core app container, such as Docker Sandbox execution or approved runtime add-on start/stop.

### HuggingFace Artifact

An Artifact that embeds a HuggingFace Space. Current HuggingFace embeds are user-only panel runtimes, not normal agent-usable Artifact tools.

## I

### Infinite Session

An opt-in, one-way session type where one agent lives in one ongoing conversation. Infinite Sessions auto-lock, pin to their own sidebar section, organize life into episodes, and use naps instead of Compact. See [Memory & Infinite Sessions](../chat/memory-and-infinite-sessions.md).

### Inworld

One of Batshit's direct realtime TTS providers when an Inworld API key and voice are configured. Batshit uses Inworld for speech output only; Batshit still owns chat context, tools, Zips, message storage, and playback events.

## L

### LiveKit

An optional realtime voice runtime for room-based audio and sidecar voice agents. LiveKit is not a TTS engine and not an STT engine.

### Local AI

Local model runtimes such as Ollama, LM Studio, Docker Model Runner, llama.cpp, or vLLM. Docker Batshit usually reaches host Local AI runtimes through `host.docker.internal`.

## M

### Mac app Batshit

Batshit running from `Batshit.app` on macOS, with Runtime Doctor supervising the local app/server/Redis helper path. Manual source-checkout setup is advanced repair/development material.

### MCP

Model Context Protocol, a standard for exposing tools to AI agents.

### MCP Gateway

A source of MCP tools. Examples include Docker MCP Gateway, n8n MCP Trigger gateways, n8n Instance MCP, custom streamable HTTP gateways, and STDIO gateways.

### Memory (Agent Memory)

Batshit's per-agent memory system: Awareness (what the agent knows right now, including its Awareness list), STM (Trigger Memories that fire when their words come up, optionally with photos), and LTM (searchable long-term memory). Off by default; managed in the Memory Panel (Settings → Memory). See [Memory & Infinite Sessions](../chat/memory-and-infinite-sessions.md).

### Model Preset

A saved provider/model configuration Batshit can reuse for agents, Artifacts, or other model-powered features.

### Mood

A persistent Goon expression or motion state that stays active until changed.

## N

### n8n

A workflow automation platform. Batshit uses n8n for workflow tools, Workflow Subagents, MCP gateways, uploads, and Artifact workflows.

### n8n Workflow Subagent

A separate n8n workflow with its own webhook, called by an `API` or `CLI` Primary Agent as a specialist.

### Nap

An Infinite Session's between-turns context relief: graduate finished episodes, compress stale tool output, and condense the oldest open-episode narrative while promoting key working facts onto the episode whiteboard. Replaces Compact inside Infinite Sessions; every nap leaves a visible record.

## P

### Primary Agent

The main AI agent you chat with directly. Batshit has `API` and `CLI` Primary Agent types.

### Project

A folder Batshit can show in the file tree and use as active context for agents.

### Project Rules

Structured guidance attached to a Project. Project rules guide agents but are not a filesystem security boundary.

## R

### Redis

Batshit's main data store for user settings, agents, messages, zips, clips, artifacts, Goons, and other app records. Batshit runs Redis 8, which builds in the JSON support Batshit needs. Docker keeps Redis internal-only by default.

The full product name is Redis Open Source, distributed under a choice of three licenses: RSALv2, SSPLv1, or AGPLv3. Batshit used the older Redis Stack 7.4 before the alpha Redis 8 update; Redis Stack is retired, and Redis 8 replaced it.

### Rhubarb WASM

Batshit's browser-worker lip-sync analyzer for completed-audio Goon mouth shapes where supported. Realtime provider-viseme lanes, currently Inworld, can drive live Goon mouth shapes without waiting for Rhubarb analysis.

### Runtime Add-On

An optional service Batshit can connect to, start through an approved operator, or guide you to start manually. Examples include Cloudflared, FBX-to-VRMA, Agent Browser, LiveKit, and `comfyui-validation`.

## S

### Sandbox

An isolated execution environment. In Batshit docs, this usually means Apple Container for Mac app command execution and Docker Sandbox for Docker or cross-platform command execution.

### Schema Hints

Compact, on-demand tool descriptions returned by Dynamic Tool Search. Instead of loading every tool's full schema into the prompt up front, Batshit gives an agent just enough detail to call the tool it picked, which saves context.

### Share to Chat

An Artifact action that saves Artifact output into the current chat, often as a text message or Clip-backed file/image.

### Shitty but Fast

Batshit's quick Goon lip-sync path based on amplitude/timing. It is useful as a fast fallback.

### Skill

A reusable instruction bundle with optional reference files and scripts. Users can invoke Skills with slash commands, and agents may also load enabled Skills when a request clearly matches the Skill's purpose.

### Speech-to-text

The process of turning spoken audio into text. Abbreviated as STT.

### Subagent

A specialist assistant called by a Primary Agent. Subagents are not general MCP tools, even though they are invoked through tool-like calls.

## T

### Text-to-speech

The process of turning assistant text into spoken audio. Abbreviated as TTS.

### Tool

An action an agent can call. Tools can come from MCP gateways, Batshit native controls, saved CLI Tool records, n8n workflows, Artifact runtime tools, or runtime add-on catalogs.

### Tool Grid

The settings surface that controls tool discoverability, display detail, and Zip behavior for global defaults, agents, subagents, skills, chatbar scope, and groups.

### Tool Results Summary

A user-visible, collapsed-by-default note panel on assistant messages. Agents can use it to keep short facts from tool calls available after large tool results are zipped. It is app metadata, not private reasoning.

### TTS/STT Engine

A configured voice engine for speech output, speech input, or both. Engines can be built-in providers, BYO services, local runtimes, or connect-existing records depending on support.

## V

### Voice Mode

Batshit's phone-style speech conversation flow. Voice Mode can listen, submit speech turns, speak replies, and handle interruption where the selected lane supports it.

### Voice Studio

The Voice Settings area for testing speech and managing voice clones/profiles.

### VRM

A 3D avatar format. VRM 1.0 is Batshit's full live Goon runtime format for launch.

### VRMA

VRM Animation, a reusable animation format for Goons.

## W

### Webhook

A URL that receives a request from Batshit or another service. n8n Workflow Subagents and webhook-backed Artifacts use webhooks.

### Workspace

The files and runtime context available to Batshit agents. In Docker, the normal workspace path is `/workspace`.

## Z

### Zip

Batshit's compressed representation of large assistant output or tool output. Zips keep the UI inspectable while reducing model context waste.

### Zip Control

Settings and permissions that decide when an item stays compressed, expands for the model, or can be unzipped/rezipped by the user or an agent.

### Zip Buffer

The number of previous agent/assistant responses whose zippable output stays expanded for model context. It does not count user messages or individual tool calls.

### Zip Threshold

The minimum token size before `Normal` Zip behavior may compress content. A threshold of `0` means there is no minimum-size floor.

### Zip Behavior

`Off` never zips. `Normal` uses buffer and threshold. `Auto` zips immediately by default.
