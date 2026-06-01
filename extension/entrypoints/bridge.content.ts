// ISOLATED-world content script: forwards per-conversation stats from any
// MAIN-world interceptor to the background service worker. Service-agnostic.
// Also handles geolocation detection requests from the popup.

import { detectUserLocation, getStoredLocation, saveLocation } from '@/lib/location';

const BRIDGE_SOURCE = 'hidden-carbon';
const DEBUG = true;

const log = (...args: unknown[]) => {
  if (DEBUG) console.log('%c[hidden-carbon:bridge]', 'color:#7ed490', ...args);
};

export default defineContentScript({
  matches: ['*://claude.ai/*', '*://chatgpt.com/*', '*://gemini.google.com/*'],
  main() {
    log('bridge listening');

    // Listen for location detection requests from the popup.
    browser.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'detect-location') {
        (async () => {
          const existing = await getStoredLocation();
          if (existing) return; // already have one
          try {
            const loc = await detectUserLocation();
            await saveLocation(loc);
            log('location saved', loc.lat, loc.lng);
          } catch (err) {
            log('geolocation failed', err);
          }
        })();
      }
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source !== BRIDGE_SOURCE) return;

      if (data.type === 'conversation') {
        browser.runtime
          .sendMessage({
            type: 'conversation',
            service: data.service,
            uuid: data.uuid,
            name: data.name,
            model: data.model,
            messageCount: data.messageCount,
            humanChars: data.humanChars,
            assistantChars: data.assistantChars,
          })
          .catch((err) => log('background send failed', err));
      }
    });
  },
});
