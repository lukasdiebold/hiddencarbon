import { ConversationStats, SERVICE_NAMES, ServiceName, statsToGCO2 } from '@/lib/stats';
import {
  getCachedIntensityForService,
  registerGridIntensityAlarm,
} from '@/lib/grid-intensity';

const STORAGE_KEY = 'conversations';
const DEBUG = true;
const log = (...args: unknown[]) => {
  if (DEBUG) console.log('[hidden-carbon:bg]', ...args);
};

async function getAll(): Promise<Record<string, ConversationStats>> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Record<string, ConversationStats>) ?? {};
}

async function saveOne(stats: ConversationStats) {
  const all = await getAll();
  all[stats.uuid] = stats;
  await browser.storage.local.set({ [STORAGE_KEY]: all });
}

async function updateBadge(stats: ConversationStats, tabId?: number) {
  const gridIntensity = await getCachedIntensityForService(stats.service);
  const gCO2 = statsToGCO2(stats, gridIntensity);
  const text = gCO2 === 0 ? '' : gCO2 < 10 ? gCO2.toFixed(1) : Math.round(gCO2).toString();
  await browser.action.setBadgeText(tabId != null ? { text, tabId } : { text });
  await browser.action.setBadgeBackgroundColor({ color: '#2d5016' });
}

export default defineBackground(() => {
  log('background worker started');

  // Register the daily Electricity Maps refresh alarm.
  registerGridIntensityAlarm();

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'conversation') {
        const service: ServiceName = SERVICE_NAMES.includes(msg.service)
          ? (msg.service as ServiceName)
          : 'claude';
        const stats: ConversationStats = {
          uuid: msg.uuid,
          service,
          name: msg.name ?? '',
          model: msg.model ?? '',
          messageCount: msg.messageCount ?? 0,
          humanChars: msg.humanChars ?? 0,
          assistantChars: msg.assistantChars ?? 0,
          lastSeen: Date.now(),
        };
        await saveOne(stats);
        await updateBadge(stats, sender.tab?.id);
        const gridIntensity = await getCachedIntensityForService(service);
        log('saved', service, stats.uuid, {
          msgs: stats.messageCount,
          gCO2: statsToGCO2(stats, gridIntensity),
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'conversation:get') {
        const all = await getAll();
        sendResponse(msg.uuid ? (all[msg.uuid] ?? null) : null);
        return;
      }

    })();
    return true;
  });
});
