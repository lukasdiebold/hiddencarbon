// MAIN-world content script: wraps window.fetch and reads the JSON response
// from ChatGPT's conversation GET endpoint. Walks the message tree from
// `current_node` upward to extract the user's currently-visible branch,
// summing characters per role.

const BRIDGE_SOURCE = 'hidden-carbon';
const DEBUG = true;

// Matches /backend-api/conversation/{uuid} (no trailing path).
const CONVO_PATH = /^\/backend-api\/conversation\/[a-f0-9-]+\/?$/i;

const log = (...args: unknown[]) => {
  if (DEBUG) console.log('%c[hidden-carbon:chatgpt]', 'color:#10a37f;font-weight:bold', ...args);
};

export default defineContentScript({
  matches: ['*://chatgpt.com/*'],
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

      if (!host.endsWith('chatgpt.com') || !CONVO_PATH.test(path)) {
        return response;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return response;
      }

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
          { source: BRIDGE_SOURCE, type: 'conversation', service: 'chatgpt', ...stats },
          '*',
        );
      } catch (e) {
        log('conversation parse error', e);
      }
    }

    function computeStats(data: any) {
      if (!data || typeof data !== 'object') return null;
      if (typeof data.conversation_id !== 'string') return null;
      if (!data.mapping || typeof data.mapping !== 'object') return null;
      if (typeof data.current_node !== 'string') return null;

      // Walk from the current leaf up to the root to get the active branch.
      // ChatGPT's tree has siblings for regenerations/edits; we only count
      // the user-visible path.
      const branch: any[] = [];
      let nodeId: string | null = data.current_node;
      let safety = 0;
      while (nodeId && safety++ < 10_000) {
        const node = data.mapping[nodeId];
        if (!node) break;
        branch.unshift(node);
        nodeId = node.parent;
      }

      let humanChars = 0;
      let assistantChars = 0;
      let messageCount = 0;
      let model = '';

      for (const node of branch) {
        const msg = node?.message;
        if (!msg) continue;

        const role = msg.author?.role;
        if (role !== 'user' && role !== 'assistant') continue;

        const ct = msg.content?.content_type;
        if (ct !== 'text' && ct !== 'multimodal_text') continue;

        const parts = msg.content.parts;
        if (!Array.isArray(parts)) continue;

        const chars = parts.reduce((sum: number, p: any) => {
          if (typeof p === 'string') return sum + p.length;
          // multimodal parts can be objects with .text or describe images
          if (p && typeof p === 'object' && typeof p.text === 'string') {
            return sum + p.text.length;
          }
          return sum;
        }, 0);

        if (chars === 0) continue;

        messageCount++;
        if (role === 'user') humanChars += chars;
        else assistantChars += chars;

        const m = msg.metadata?.model_slug || msg.metadata?.resolved_model_slug;
        if (typeof m === 'string' && m) model = m;
      }

      if (!model && typeof data.default_model_slug === 'string') {
        model = data.default_model_slug;
      }

      return {
        uuid: data.conversation_id as string,
        name: typeof data.title === 'string' ? data.title : '',
        model,
        messageCount,
        humanChars,
        assistantChars,
      };
    }
  },
});
