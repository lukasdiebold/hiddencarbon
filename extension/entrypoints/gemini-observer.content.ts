// ISOLATED-world content script: DOM observer for gemini.google.com.
//
// Gemini's API uses Google's internal batchexecute RPC format (positionally
// nested arrays with no field names), which is too fragile to parse. Instead,
// we read the rendered conversation directly from the DOM. The Angular bundle
// uses semantic class names (.conversation-container, .query-text,
// .markdown-main-panel) that are stable enough to rely on.
//
// We mount a MutationObserver on document.body, recompute on every change
// (debounced), and post a `{ service: 'gemini', uuid, ... }` payload to the
// bridge — the same shape used by the Claude and ChatGPT interceptors.

const BRIDGE_SOURCE = 'hidden-carbon';
const DEBUG = true;
const DEBOUNCE_MS = 600;
const URL_RE = /\/app\/([a-f0-9]+)/i;

const log = (...args: unknown[]) => {
  if (DEBUG) console.log('%c[hidden-carbon:gemini]', 'color:#4285f4;font-weight:bold', ...args);
};

export default defineContentScript({
  matches: ['*://gemini.google.com/*'],
  main() {
    log('observer starting');

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPosted: string | null = null;

    function getConversationUuid(): string | null {
      const m = location.pathname.match(URL_RE);
      return m ? m[1] : null;
    }

    function chars(el: Element | null): number {
      if (!el) return 0;
      const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
      return text.trim().length === 0 ? 0 : text.length;
    }

    function computeAndPost() {
      const uuid = getConversationUuid();
      if (!uuid) return;

      const containers = document.querySelectorAll('.conversation-container');
      let humanChars = 0;
      let assistantChars = 0;
      let messageCount = 0;

      containers.forEach((container) => {
        const userChars = chars(container.querySelector('.query-text'));
        if (userChars > 0) {
          humanChars += userChars;
          messageCount++;
        }
        // Gemini sometimes renders alternate responses (regenerations). Take
        // the first .markdown-main-panel per container — that's the visible one.
        const responseChars = chars(container.querySelector('.markdown.markdown-main-panel'));
        if (responseChars > 0) {
          assistantChars += responseChars;
          messageCount++;
        }
      });

      if (humanChars === 0 && assistantChars === 0) return;

      const stats = {
        uuid,
        name: document.title.replace(/\s*[-—]\s*Gemini\s*$/, '').trim() || '',
        model: 'gemini',
        messageCount,
        humanChars,
        assistantChars,
      };

      // Dedupe: don't repost unchanged stats during repeated streaming mutations.
      const fingerprint = `${uuid}:${messageCount}:${humanChars}:${assistantChars}`;
      if (fingerprint === lastPosted) return;
      lastPosted = fingerprint;

      log('captured', stats);
      window.postMessage(
        { source: BRIDGE_SOURCE, type: 'conversation', service: 'gemini', ...stats },
        '*',
      );
    }

    function schedule() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(computeAndPost, DEBOUNCE_MS);
    }

    // Observe everything under <body>. Costs little — the debounce dominates.
    function start() {
      if (!document.body) {
        setTimeout(start, 100);
        return;
      }
      new MutationObserver(schedule).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      schedule();
    }
    start();
  },
});
