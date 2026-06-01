import './style.css';
import { GOOGLE_SEARCH_G, YOUTUBE_G_PER_MIN, whFromTokens, whToGCO2 } from '@/lib/emissions';
import { ConversationStats, estimateTokens } from '@/lib/stats';
import { getCachedIntensityForService, getRegionBreakdown, getUserLocationLabel } from '@/lib/grid-intensity';
import { getStoredLocation } from '@/lib/location';

const ICON_URL = browser.runtime.getURL('/icon/hidden-carbon-light.svg');

function extractConversationUuid(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.host.endsWith('claude.ai')) {
      const m = u.pathname.match(/\/chat\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    }
    if (u.host.endsWith('chatgpt.com')) {
      const m = u.pathname.match(/\/c\/([a-f0-9-]+)/i);
      return m ? m[1] : null;
    }
    if (u.host.endsWith('gemini.google.com')) {
      const m = u.pathname.match(/\/app\/([a-f0-9]+)/i);
      return m ? m[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function setHtml(html: string) {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = html;
}

function footerHtml(meta: string): string {
  return `
    <div class="footer">
      <span class="footer-meta">${meta}</span>
    </div>
  `;
}

function shellHtml(bodyHtml: string): string {
  return `
    <div class="top-bar"></div>
    <div class="header">
      <div class="header-left">
        <img class="header-icon" src="${ICON_URL}" width="26" height="26" alt="Hidden Carbon icon"/>
        <span class="header-title">Hidden Carbon</span>
      </div>
    </div>
    ${bodyHtml}
  `;
}

async function render() {
  // Ensure we have a stored user location for distance-based weighting.
  // Geolocation API is unavailable in extension popups, so we detect from
  // a content script (see bridge.content.ts). If no location is stored yet,
  // we fall back to equal weights.
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

  // Request location detection from the active tab's content script.
  const existingLoc = await getStoredLocation();
  if (!existingLoc && activeTab?.id) {
    try {
      await browser.tabs.sendMessage(activeTab.id, { type: 'detect-location' });
    } catch {
      // Content script not available on this tab — that's fine.
    }
  }

  const uuid = extractConversationUuid(activeTab?.url);

  if (!uuid) {
    setHtml(
      shellHtml(
        `<section class="empty">
          Open a Claude, ChatGPT, or Gemini conversation to see its footprint.
        </section>
        ${footerHtml('—')}`,
      ),
    );
    return;
  }

  const stats = (await browser.runtime.sendMessage({
    type: 'conversation:get',
    uuid,
  })) as ConversationStats | null;

  if (!stats) {
    setHtml(
      shellHtml(
        `<section class="empty">
          Refresh the conversation to load stats.
        </section>
        ${footerHtml('no data yet')}`,
      ),
    );
    return;
  }

  const inT = estimateTokens(stats.humanChars);
  const outT = estimateTokens(stats.assistantChars);
  const wh = whFromTokens(inT, outT);
  const gridIntensity = await getCachedIntensityForService(stats.service);
  const gCO2 = whToGCO2(wh, gridIntensity);
  const ytMin = gCO2 / YOUTUBE_G_PER_MIN;
  const searches = gCO2 / GOOGLE_SEARCH_G;

  // Build datacenter breakdown table
  const breakdown = await getRegionBreakdown(stats.service);
  const dcRows = breakdown
    .map(
      (r) =>
        `<tr>
          <td>${escapeHtml(r.label)}</td>
          <td>${r.gPerKwh != null ? Math.round(r.gPerKwh) : '—'}</td>
          <td>${r.weightPct.toFixed(0)}%</td>
        </tr>`,
    )
    .join('');

  const body = `
    <section class="hero">
      <div class="hero-number">${gCO2.toFixed(2)}</div>
      <div class="hero-meta">
        <span class="hero-unit">g CO₂</span>
      </div>
    </section>

    <div class="divider"></div>

    <section class="stats-grid">
      <div class="stat-cell">
        <span class="stat-value">${stats.messageCount}</span>
        <span class="stat-label">Messages</span>
      </div>
      <div class="stat-cell">
        <span class="stat-value">${wh.toFixed(2)}</span>
        <span class="stat-label">Wh energy</span>
      </div>
      <div class="stat-cell">
        <span class="stat-value">${fmt(inT)}</span>
        <span class="stat-label">In tokens</span>
      </div>
      <div class="stat-cell">
        <span class="stat-value">${fmt(outT)}</span>
        <span class="stat-label">Out tokens</span>
      </div>
    </section>

    <div class="divider"></div>

    <section class="equiv">
      <div class="equiv-row">
        <span class="equiv-value">≈ ${ytMin.toFixed(1)} min</span>
        <span class="equiv-label">of YouTube HD streaming</span>
      </div>
      <div class="equiv-row">
        <span class="equiv-value">${fmt(Math.round(searches))}</span>
        <span class="equiv-label">traditional Google searches</span>
      </div>
    </section>

    <div class="divider"></div>

    <section class="dc-breakdown">
      <div class="dc-title">Grid intensity by datacenter (avg ${Math.round(gridIntensity)} g/kWh)</div>
      <table class="dc-table">
        <thead>
          <tr><th>Location</th><th>g/kWh</th><th>Weight</th></tr>
        </thead>
        <tbody>${dcRows}</tbody>
      </table>
      <div class="dc-user-location">user based in ${escapeHtml(await getUserLocationLabel())}</div>
    </section>

    ${footerHtml(`${escapeHtml(stats.model) || 'unknown'} · chars/4 est.`)}
  `;

  setHtml(shellHtml(body));
}

render();
