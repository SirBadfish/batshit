# Pinokio `pterm` fixtures (SA-072 DL-11)

Real `pterm` output captured on 2026-09-22 from Pinokio 8.2.0 (pinokiod 8.2.0, launcher script schema 8.0.0) with
`pterm` 0.0.25 on macOS 27.0, Apple Silicon, Node 24.12.0. `pterm` ran from a plain shell (no Pinokio shell
variables) through its own `#!/usr/bin/env node`. The proof app is ComfyUI (`comfy.git`).

Each file holds one command: `argv`, `exitCode`, `signal`, `timedOut`, `durationMs`, the exact `stdout` and
`stderr`, and a `note` saying what it proves. Two values were replaced after capture and nothing else:
the home folder is `/Users/tester` and the LAN address is `192.168.1.10`.

What the parser can rely on (pterm 0.0.25):

- `search`, `status`, and `logs` print pretty JSON on stdout (the control plane's response). No flag is needed.
- `home` and `which` print one plain path unless `--json` is given; `which` of an unknown command exits 1 with
  `command not found: <name>` on stderr.
- `version terminal|pinokiod|pinokio|script` print one line; when the control plane is down, `version pinokio`
  exits 0 and prints nothing.
- Every failed request (unknown app id, control plane down) is an uncaught AxiosError: exit 1, a Node stack and
  the full request config on stderr, the HTTP status and `data` near the end. Nothing on stdout.
- With Pinokio closed, `pterm` retries the `access` host stored in `~/.pinokio/config.json`, so the refused
  address is the machine's LAN address, not loopback.
- `run` streams the launcher's raw terminal output (ANSI colours, CRLF) and stays attached after the app is ready.
  On an app that is already online it prints the ready URL and then never exits.
- `status` fields used by SA-072: `path`, `default_target`, `state` (`offline | starting | online`), `running`,
  `ready`, `ready_url`, `external_ready_urls`, `running_scripts`, `ready_script`, `local_entries`, `probe`
  (`null` unless `--probe`), `last_error`, `source.local`, `ref`. Search results have no `path`.

A new Pinokio or `pterm` version that changes any of this means re-capturing the whole set and moving the
version floor (DL-13), never parsing two shapes at once.

## ComfyUI app answers (SA-072 P2, the Pinokio app runner)

Real answers from the Pinokio-managed ComfyUI 0.37.0 on the same Mac, captured on 2026-09-25 with a FLUX schnell
fp8 text-to-image workflow (512x512, 4 steps). Nothing was replaced; they hold no address or path. They live in `comfyui/`
because they are app answers, not `pterm` output: `pinokioService.test.ts` expects one parser case per file at the top level.

- `comfyui/prompt-accepted.json`: `POST /prompt` accepted (`prompt_id`, `number`, empty `node_errors`).
- `comfyui/prompt-validation-error.json`: `POST /prompt` refused with HTTP 400 (a checkpoint name that is not
  installed): `error.type` / `error.message` plus per-node `node_errors[<id>].errors[].details`.
- `comfyui/history-success.json`: `GET /history/<prompt_id>` once the run finished: `{ <prompt_id>: { prompt,
  outputs: { "9": { images: [{ filename, subfolder, type: "output" }] } }, status: { status_str: "success",
  completed: true, messages }, meta } }`. Before the run finishes the same request answers `{}`.
