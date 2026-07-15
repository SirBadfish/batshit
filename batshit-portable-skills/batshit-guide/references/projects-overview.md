# Projects and files

A Project tells Batshit where your files live, so an agent can read them, edit them, and run commands in the right place. File mentions then point the agent at the exact files or folders you care about.

This page covers Projects and file references. Two closely related systems have their own pages: [Clips](../clips/overview.md) for reusable image and file attachments, and [Zips and context](../tools/zips.md) for keeping large output from flooding the chat. They solve different problems: a file mention is not a Clip, and a Project is not a backup of your source code.

## Projects

A Project is a folder Batshit shows in the sidebar and uses as the active working context for an agent.

Reach for a Project when you want to:

- Have an agent understand or edit a local codebase.
- Use file mentions like `@src/app.css`.
- Give an agent a specific working path and optional Project rules.
- Run CLI agents or Bash tools from the right folder.

Each Project has a file tree, a root path, optional rules, and exclusions. Exclusions keep noisy or sensitive folders out of the file tree — typically dependency folders, build output, logs, `.git`, `.env` files, and anything holding keys.

The Project selected in the sidebar is the active working Project for the current chat. Batshit remembers the last Project you used with each agent, so switching agents can bring its previous Project back. If that Project is unavailable, or none is selected, the agent's default Project provides the fallback. Agent file tools, Bash/CLI tool paths, and n8n native-tool calls all receive the same resolved Project path.

## Mac app and Docker project paths

Mac app Batshit sees host paths directly, and so does an advanced source-checkout setup.

Docker Batshit sees project files through `/workspace`. The Docker launcher maps a host folder into the app container so agents can work on files there.

A few Docker rules matter:

- A Project path saved as `/workspace/my-project` is visible inside the Docker app container.
- A host path like `/Users/you/code/my-project` is not visible inside Docker unless you mount it.
- Backup and restore can rewrite Project path references for Docker, but they do not copy the project source tree.
- After restoring a backup into Docker, mount or copy the actual project files into `/workspace` before expecting agents to work on them.

## The file tree

The file tree is Batshit's sidebar view of the active Project. Use it to:

- Browse folders.
- Refresh the file list.
- Quick View small text files.
- Copy relative or full paths.
- Insert file or folder mentions.
- Upload a project file into Clip Vault.
- Open `.html` or `.md` content in Artifacts where supported.

Folders load their contents when you expand them, so even very large Projects open instantly. The `@` mention index builds in the background and fills in as it goes. If a listing genuinely cannot load, the tree shows a specific error — timeout, connection, or server — instead of failing silently.

The file tree does not watch every filesystem change live. Batshit refreshes when needed and marks the tree stale after file-writing tool results.

## File mentions

A file mention is a text reference in your message, usually written as `@relative/path`:

```text
Please review @src/lib/chat/send.ts and explain the risky parts.
```

Mentions are references, not uploads. They do not send the file's bytes; they tell Batshit to include structured file-reference information in the current message so the agent knows what you are pointing at.

| State | Meaning |
| --- | --- |
| Valid text file | The file can be referenced normally. |
| Folder | The folder can be referenced as a directory. |
| Missing | The path does not currently exist. |
| Excluded | The path matches Project exclusions. |
| Binary or image | Upload this as a Clip instead of referencing it as text. |

Shift-dragging a file from the tree inserts a mention. Normal dragging uploads it as a Clip.

## Project rules

Project rules are structured guidance attached to a Project. They steer AI behavior — they are not operating-system security.

Good uses:

- "This repo uses Svelte 5 runes."
- "Do not edit generated files."
- "Run package commands from this subfolder."
- "Prefer existing component patterns."

For real access boundaries, use Project root paths, exclusions, and sandbox/tool settings. Do not treat Project rules as a security wall.

## Backups don't include your source code

A Batshit backup includes Batshit's own records and upload assets. It does not include your project source folders on disk. So a backup can restore the Project *record*, but not the codebase itself.

After a restore, make sure the folder still exists at the saved path, or at the Docker `/workspace` path. Keep your code in Git or your own backup system. See [Backup and restore](../admin/backup-and-restore.md) for the full boundary.

## Practical workflow: code review

1. Select the Project.
2. Mention the files or folders with `@`.
3. Ask the agent for a focused review.
4. Use [Zips](../tools/zips.md) to inspect large tool results without flooding the chat.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Agent cannot see a file | The Project path is wrong, excluded, or not mounted in Docker. | Project root, exclusions, `/workspace` mapping. |
| File mention says binary/image | Mentions are for text references; upload media as Clips. | Use Clip upload instead. |
| Docker agent cannot reach a `localhost` path | Inside Docker, `localhost` means the container, and host paths need mounting. | Mount the folder and use `/workspace` paths. |

## Related docs

- [Clips](../clips/overview.md)
- [Zips and context](../tools/zips.md)
- [Primary Agents](../primary-agents/overview.md)
- [Security and trust](../security/overview.md)
