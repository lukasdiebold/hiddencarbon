# Hidden Carbon

A Chrome extension for real-time CO₂ tracking of digital services, focused on
the activities that dominate everyday browsing: AI chat, video, and search.

University of Washington — *Sustainable & Ubiquitous AI*, Spring 2026.
Authors: Lukas Diebold, Hari Sethuraman.

## Tech stack

- [WXT](https://wxt.dev) — Vite-based MV3 extension framework
- TypeScript (vanilla, no UI framework)
- Chrome MV3 service worker + content scripts + popup

## Setup

```bash
cd extension
npm install
npm run build
```

This writes a production-mode build to `extension/.output/chrome-mv3/` with
a static `content_scripts` manifest entry. The extension is loaded manually
into your normal Chrome — Cloudflare blocks automated/launcher-driven Chrome
on claude.ai, so WXT's `wxt dev` browser-launch flow doesn't work for this
project. (`wxt dev` also generates a manifest with no `content_scripts` and
relies on a running dev server to inject them, which doesn't help us.)

### Load the extension

1. Open `chrome://extensions` in your normal Chrome.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick `extension/.output/chrome-mv3/`.
4. Pin the extension so the badge is visible in the toolbar.

### Iterate

After editing code:

```bash
npm run build
```

Then click the circular reload arrow on the Hidden Carbon card in
`chrome://extensions`. For content-script changes, also refresh the claude.ai
tab so the new MAIN-world interceptor is injected at `document_start`.

### Package for distribution

```bash
npm run zip        # outputs a zip ready for the Chrome Web Store
```

## Project layout

```
suai_project/
├── proposal/                  # class proposal (HTML/CSS)
└── extension/
    ├── wxt.config.ts          # manifest + WXT config
    ├── lib/
    │   ├── emissions.ts       # per-token Wh rates, gCO₂ + YouTube conversions
    │   └── stats.ts           # ConversationStats type, chars→tokens, Wh, gCO₂
    └── entrypoints/
        ├── background.ts                       # service worker: storage + badge
        ├── bridge.content.ts                   # ISOLATED world: shared postMessage → runtime forwarder
        ├── claude-interceptor.content.ts       # MAIN world: claude.ai conversation JSON
        ├── chatgpt-interceptor.content.ts      # MAIN world: chatgpt.com conversation JSON
        ├── gemini-observer.content.ts          # ISOLATED world: gemini.google.com DOM observer
        └── popup/                              # toolbar popup UI
            ├── index.html
            ├── main.ts
            └── style.css
```

## How detection works

Three content scripts cooperate, one ISOLATED bridge and two MAIN-world
interceptors (one per service):

1. **`claude-interceptor.content.ts`** runs on `claude.ai` in **MAIN** world
   at `document_start` and wraps `window.fetch`. It filters for responses
   whose path matches `/api/organizations/{uuid}/chat_conversations/{uuid}`
   with `Content-Type: application/json`. On a match it parses the JSON and
   walks `chat_messages[].content[]`, summing character counts per `sender`
   (`human` / `assistant`). Text, thinking blocks, and serialized tool
   inputs all count.

2. **`chatgpt-interceptor.content.ts`** runs on `chatgpt.com` in **MAIN**
   world at `document_start`, same wrap pattern. It filters for
   `/backend-api/conversation/{uuid}` with JSON content-type. ChatGPT's
   response shape is a tree (`mapping: { [nodeId]: { id, message, parent,
   children } }`), so the parser starts at `current_node` and walks back up
   via `parent` to reconstruct the user-visible branch — siblings exist for
   regenerated/edited turns and are deliberately skipped. For each message
   in the branch it sums `content.parts[]` chars when `content_type` is
   `text` or `multimodal_text`, splitting on `author.role`.

3. **`gemini-observer.content.ts`** runs on `gemini.google.com` in the
   default **ISOLATED** world. Gemini's API uses Google's `batchexecute` RPC
   format (positionally-nested arrays with no field names), which is too
   fragile to parse — so this script reads the rendered conversation from
   the DOM instead. A `MutationObserver` on `document.body` schedules a
   debounced recompute (600 ms) every time the DOM changes. The compute pass
   walks `.conversation-container` nodes and pulls the user's prompt from
   `.query-text` and the model's reply from `.markdown.markdown-main-panel`,
   summing characters per role. A fingerprint of `(uuid, msgs, in, out)`
   suppresses redundant posts during streaming.

4. **`bridge.content.ts`** runs on all three hosts in the default
   **ISOLATED** world and forwards window messages to the background via
   `browser.runtime.sendMessage`. The bridge is required because extension
   APIs aren't available in MAIN world.

The **background worker** stores per-conversation records in
`chrome.storage.local` keyed by uuid, so stats persist across browser
restarts and a user can open an old conversation to see its footprint. It
also sets a per-tab badge with the active conversation's gCO₂.

The **popup** reads the active tab's URL, pulls the conversation uuid from
`/chat/{uuid}` (Claude), `/c/{uuid}` (ChatGPT), or `/app/{uuid}` (Gemini),
and asks the background for that conversation's stored stats.

### Token estimation

claude.ai's web API doesn't expose `input_tokens` / `output_tokens` in any
response (unlike Anthropic's public Messages API). We approximate with the
standard BPE heuristic: **`tokens = ceil(chars / 4)`** — accurate to ~±15%
for English text, which is well within the uncertainty range of the
per-token energy factors.

Energy is then computed as `Wh = input_tokens · 0.0001 + output_tokens · 0.0006`,
and `gCO₂ = (Wh / 1000) · 400`. Constants and citations live in
[extension/lib/emissions.ts](extension/lib/emissions.ts).

This counts only what the user typed (human messages) and what the model
generated (assistant messages). It deliberately ignores the full per-turn
prefill cost (system prompt, tool schemas, conversation history that
claude.ai resends each turn), because attributing the full prefill to each
user message would make every query look identical regardless of what the
user actually did — and most of that context is server-side prompt-cached
anyway. This is the "marginal cost" view: what *this conversation's
content* cost, not what the data center actually paid.
