# batshit-server

batshit-server is Batshit's local helper service for filesystem/upload work and batshit-server-owned upload serving. It also ships a separate stdio MCP helper script that private launchers can wrap with Supergateway for the optional streamable helper port. The Express server itself does not expose `/mcp`; it is not the SvelteKit app and it is not a general public API.
Chat sessions, messages, execution logs, and app-owned zip lifecycle live in the SvelteKit app backed by Redis, not in batshit-server.

Primary responsibilities:

- Serve uploaded assets from the batshit-server upload root.
- Execute the allow-listed helper task surface used by Batshit.
- Provide the stdio MCP helper process used by managed CLI/tool lanes and optional Supergateway wrapping.

Security boundary:

- `/health` and `/api/v1/health` are public readiness checks.
- Read-only `/uploads/*` GET/HEAD clip serving is public so model-visible clip URLs can work.
- All `/api` and `/api/v1` routes require Batshit's service token.

Commands:

```sh
cd batshit-server/server
npm install
npm test
npm start
```

For normal public installs, batshit-server is launched by the Mac app runtime or Docker Compose rather than started by hand.
