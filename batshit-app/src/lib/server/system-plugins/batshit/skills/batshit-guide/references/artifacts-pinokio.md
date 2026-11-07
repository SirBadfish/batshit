# Pinokio apps as Artifacts

Pinokio is a free app launcher that installs and runs AI apps on your own computer: ComfyUI, speech and OCR tools, image editors, and hundreds more, each with one click. Batshit can turn any of those apps into an Artifact, so you get a tidy panel for it inside Batshit, and your agents can use it too.

Pinokio is optional. Batshit works exactly the same without it, and nothing on this page changes unless Pinokio is installed and running.

## What you need

- **Pinokio 8.2.0 or newer**, installed on the same computer as Batshit and open. **Settings → Admin → Runtimes → Pinokio** says whether Batshit found it.
- **The app itself, installed in Pinokio.** Batshit never installs, downloads, stops, or deletes Pinokio apps. You install them in Pinokio, the normal way.
- The Mac app or a source install of Batshit. A Batshit running in Docker can't reach a Pinokio on the host, and Settings says so.

## How it works

You ask an agent for an Artifact around one of your Pinokio apps, in plain words: "make me an artifact for my ComfyUI in Pinokio that generates images from a prompt", or "turn the OCR app in Pinokio into something I can drop pictures on".

The agent finds the app in Pinokio, reads what the app can do, and builds the Artifact with the **Artifact Creator** skill. If the app isn't running, it asks Pinokio to start it, and you see an **Approve** card first. Nothing starts without your click.

The finished Artifact talks to the app's own API through Batshit:

- It never stores the app's address. Every time it runs, Batshit asks Pinokio where the app is right now, so a new port after a restart doesn't break it.
- Its badge names the real app and its manager: **ComfyUI via Pinokio**, **Gradio via Pinokio**, or **Custom API via Pinokio**.
- Your agents can run it like any other agent-usable Artifact, from any chat. An image it makes lands in the chat as a Clip.
- For an app that reads a picture (OCR, background removal, upscaling), attach the picture to your message and ask the agent to run the Artifact on it. The agent hands the attached Clip to the app.

## When the app isn't running

Pinokio apps use a lot of memory, so you'll often have them closed. That's fine:

- **In the Artifact's panel**, a small note appears with **Start with Pinokio**. Click it, confirm in Batshit's dialog (it names the app, and any other app it needs), and the panel runs your request as soon as the app answers. **Not now** leaves everything as it was.
- **When an agent runs it**, the agent is told the app is off and asks to start it with the same **Approve** card.

Starting an app can take a minute, longer the first time. If it's still starting, the note offers **Try Again**.

## Which apps work

| App kind | What Batshit calls | Good for |
| --- | --- | --- |
| ComfyUI | Your saved workflow, with the fields you chose (prompt, steps, size, and so on) | Image generation from a prompt |
| Gradio | One of the app's functions, the one its own page uses | Most Pinokio apps: OCR, speech, upscaling, background removal |
| Custom API | One address on the app, with the fields as JSON | Apps with their own small web API |

A ComfyUI Artifact through Pinokio can't take an input picture yet (workflows with a Load Image node). Everything else about ComfyUI works as it does outside Pinokio.

## Choosing it by hand

The agent sets all of this for you. To look at it or change it yourself, open **Settings → Artifacts**, pick the Artifact, and open **Advanced Builder**. **Artifact Power Source** reads **Pinokio App**, with two more rows under it: **App Kind** and **Pinokio App** (the installed app it uses).

## Related

- [Artifacts](overview.md): what Artifacts are and how they're published.
- [Artifacts and agent use](agent-use.md): which agents can run an Artifact.
