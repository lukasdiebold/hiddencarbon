// MAIN-world content script: wraps window.fetch and reads the JSON response
// from claude.ai's chat-conversation GET endpoint. That payload contains the
// full message history, so we can compute per-conversation token estimates
// without touching the streaming completion endpoint.

const BRIDGE_SOURCE = 'hidden-carbon';
const DEBUG = true;

// Matches /api/organizations/{org_uuid}/chat_conversations/{conv_uuid}
// (optionally with a trailing slash). Excludes /completion and other suffixes.
const CONVO_PATH = /^\/api\/organizations\/[a-f0-9-]+\/chat_conversations\/[a-f0-9-]+\/?$/i;

const log = (...args: unknown[]) => {
  if (DEBUG) console.log('%c[hidden-carbon:main]', 'color:#7ed490;font-weight:bold', ...args);
};

export default defineContentScript({
  matches: ['*://claude.ai/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    log('fetch wrapper installed');
    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(input, init) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await originalFetch.call(this, input as RequestInfo | URL, init);

      let path = '';
      let host = '';
      try {
        const parsed = new URL(url, location.origin);
        path = parsed.pathname;
        host = parsed.host;
      } catch {
        return response;
      }

      if (!host.endsWith('claude.ai') || !CONVO_PATH.test(path)) {
        return response;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return response;
      }

      // Read our own clone so the page's copy is untouched.
      void inspectConversation(response.clone());
      return response;
    };

    async function inspectConversation(clone: Response) {
      try {
        const data = await clone.json();
        const stats = computeStats(data);
        if (!stats) {
          log('conversation parse: no usable shape');
          return;
        }
        log('conversation captured', stats);
        window.postMessage(
          { source: BRIDGE_SOURCE, type: 'conversation', service: 'claude', ...stats },
          '*',
        );
      } catch (e) {
        log('conversation parse error', e);
      }
    }

    function computeStats(data: any) {
      if (!data || typeof data !== 'object') return null;
      if (typeof data.uuid !== 'string' || !Array.isArray(data.chat_messages)) return null;

      let humanChars = 0;
      let assistantChars = 0;

      for (const msg of data.chat_messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        const chars = msg.content.reduce((sum: number, b: any) => sum + getBlockChars(b), 0);
        if (msg.sender === 'human') humanChars += chars;
        else if (msg.sender === 'assistant') assistantChars += chars;
      }

      return {
        uuid: data.uuid as string,
        name: typeof data.name === 'string' ? data.name : '',
        model: typeof data.model === 'string' ? data.model : '',
        messageCount: data.chat_messages.length,
        humanChars,
        assistantChars,
      };
    }

    // Pulls text-like content from a single content block. Handles text,
    // thinking blocks, and tool-use JSON inputs. Tool results are still TODO.
    function getBlockChars(block: any): number {
      if (!block || typeof block !== 'object') return 0;
      let total = 0;
      if (typeof block.text === 'string') total += block.text.length;
      if (typeof block.thinking === 'string') total += block.thinking.length;
      if (block.input && typeof block.input === 'object') {
        try {
          total += JSON.stringify(block.input).length;
        } catch {
          /* ignore */
        }
      }
      return total;
    }
  },
});
