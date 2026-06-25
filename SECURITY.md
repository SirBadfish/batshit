# Security policy

Batshit is alpha self-hosted software. Please report security issues privately so they can be fixed before details are public.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on the public repository once it is enabled.

If private vulnerability reporting is unavailable, use the contact channel listed on the Batshit website or repository profile. Do not open a public issue for suspected vulnerabilities, secrets exposure, auth bypasses, remote code execution, sandbox escapes, or data-loss bugs.

Please include:

- a clear description of the issue
- affected setup path: Mac app, Docker, or source checkout
- steps to reproduce
- impact and any data or permissions involved
- whether you have already shared details anywhere else

## Scope

In scope:

- Batshit app, batshit-server, Docker/Compose files, Mac app packaging, bundled public docs, and first-party runtime helper code
- authentication/session handling
- upload, backup/restore, sandbox, tool execution, and service-token boundaries
- public repository secrets or private data exposure

Out of scope:

- social engineering
- denial-of-service reports without a practical security impact
- issues in third-party services Batshit connects to, unless Batshit is using them unsafely
- vulnerabilities that require already having full local control of the user's machine

## Supported versions

Batshit is pre-1.0. Only the current public release line is supported for security fixes.

## Safe harbor

Good-faith security research is welcome when it avoids privacy violations, data destruction, service disruption, persistence, or public disclosure before a fix is available.
