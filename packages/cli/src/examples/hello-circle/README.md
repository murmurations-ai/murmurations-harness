# Hello-Circle — Minimal Murmuration Example

A 2-agent, 1-group murmuration preconfigured to run end-to-end with zero setup beyond a Gemini API key. Shipped with `@murmurations-ai/cli` and extracted via:

```sh
murmuration init --example hello my-hello-murm
cd my-hello-murm
```

## What's here

```
my-hello-murm/
├── murmuration/
│   ├── soul.md                   # Constitutional layer
│   ├── harness.yaml              # Gemini + local collaboration + no governance plugin
│   └── default-agent/            # ADR-0027 fallback templates
├── agents/
│   ├── host-agent/               # Facilitator — runs the meeting
│   └── scout-agent/              # Member — contributes observations
├── governance/
│   └── groups/
│       └── example.md            # The one group, with host-agent as facilitator
├── .env.example                  # GEMINI_API_KEY placeholder
└── .gitignore
```

## Run a meeting

```sh
# 1. Paste your Gemini key
cp .env.example .env
chmod 600 .env
# edit .env and paste your key from https://aistudio.google.com/apikey

# 2. Verify the setup
murmuration doctor --root .

# 3. Wake the group with a directive
murmuration convene --root . --group example --directive "what should we scout next?"
```

The host invites scout's observation, synthesizes a summary, names a next step. Meeting minutes land in `.murmuration/items/` locally (no GitHub needed).

## What this is _not_

- Not production. Everything here is minimal to demonstrate the mechanics.
- Not governed. Real murmurations plug in a governance model (S3, chain-of-command, etc.). Hello-circle uses the no-op plugin so meetings just run.
- Not persistent. Delete `.murmuration/` and nothing is lost.

## Next step

When you're ready to move past the demo:

```sh
murmuration init    # interactive interview → your real murmuration
```
