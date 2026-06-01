import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Hidden Carbon',
    description: 'Real-time CO₂ tracking for AI chat, video, and search.',
    permissions: ['storage', 'geolocation', 'alarms'],
    host_permissions: [
      '*://claude.ai/*',
      '*://chatgpt.com/*',
      '*://gemini.google.com/*',
      '*://api.electricitymap.org/*',
    ],
  },
  // Skip launching a browser on `wxt dev` — extension is loaded manually
  // into the user's real Chrome via chrome://extensions. WXT still watches
  // files and rebuilds .output/chrome-mv3-dev on every save; click the
  // reload icon on the extension card to pick up changes.
  webExt: {
    disabled: true,
  },
});
