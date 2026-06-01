import { ServiceName, whFromTokens, whToGCO2, GRID_G_PER_KWH } from './emissions';

// chars-per-token heuristic — standard BPE approximation for English text.
export const CHARS_PER_TOKEN = 4;

// Re-export ServiceName so existing imports from stats.ts still work.
export type { ServiceName } from './emissions';
export const SERVICE_NAMES: ServiceName[] = ['claude', 'chatgpt', 'gemini'];

export type ConversationStats = {
  uuid: string;
  service: ServiceName;
  name: string;
  model: string;
  messageCount: number;
  humanChars: number;
  assistantChars: number;
  lastSeen: number;
};

export function estimateTokens(chars: number): number {
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

export function statsToWh(stats: ConversationStats): number {
  return whFromTokens(
    estimateTokens(stats.humanChars),
    estimateTokens(stats.assistantChars),
  );
}

/**
 * Compute gCO₂ for a conversation. Accepts an optional gridIntensity
 * (gCO₂/kWh) that should come from the cached Electricity Maps data.
 * Falls back to the global average if not provided.
 */
export function statsToGCO2(
  stats: ConversationStats,
  gridIntensity: number = GRID_G_PER_KWH,
): number {
  return whToGCO2(statsToWh(stats), gridIntensity);
}
