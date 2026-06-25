# Contributing to Batshit

Batshit is maintainer-led alpha software. Contributions are welcome when they help the current product direction and keep the codebase safer, clearer, or easier to use.

## What is welcome

- bug reports with clear reproduction steps
- security reports through private vulnerability reporting
- documentation fixes
- small focused bug fixes
- small compatibility fixes for supported Mac app or Docker paths
- narrow test improvements that prove real behavior

Please discuss non-trivial work before opening a pull request. Batshit is not currently seeking unsolicited large features, major UI redesigns, architecture rewrites, product-direction changes, or roadmap-setting PRs.

## License and DCO

Batshit core code is licensed under AGPL-3.0-only. Contributions are accepted under the same license unless the maintainers explicitly say otherwise.

Batshit uses the Developer Certificate of Origin (DCO) with inbound=outbound. By contributing, you certify that you have the right to submit the work and that it can be distributed under Batshit's project license.

Sign commits with:

```sh
git commit -s
```

That adds a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

## Brand and user content

The Batshit name, logo, mascot, and visual identity are protected separately from the code license. See `TRADEMARKS.md`.

User-created chats, agents, prompts, workflows, artifacts, uploaded files, project files, generated content, and local data remain the user's content. Using or contributing to Batshit does not make a user's content AGPL-licensed Batshit code.

## Setup paths

The public install paths are Mac app and Docker. Source-checkout commands are maintainer/development workflow unless a contributor guide explicitly says otherwise.

For user-facing setup, start with `docs/user-docs/README.md`.

## Pull requests

Keep pull requests focused. Include:

- what changed
- why it changed
- how it was tested
- any risk, follow-up, or unsupported setup path

If your change touches TypeScript or Svelte in `batshit-app`, run:

```sh
cd batshit-app && npm run check
```

If your change touches tests or risky runtime behavior, run the focused tests that prove the behavior. Do not rely on snapshot-looking tests that do not exercise real code.
