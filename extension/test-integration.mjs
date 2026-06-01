// Integration test: exercises the full pipeline from API fetch → cache → gCO₂ calculation.
// Run with: ELECTRICITY_MAPS_TOKEN=... node extension/test-integration.mjs
//
// Requires network access to api.electricitymap.org.

const API_BASE = 'https://api.electricitymap.org/v3';
const API_TOKEN = process.env.ELECTRICITY_MAPS_TOKEN;
if (!API_TOKEN) {
  console.error('Set ELECTRICITY_MAPS_TOKEN in the environment before running.');
  process.exit(1);
}

// --- Constants (mirroring emissions.ts) ---
const WH_PER_INPUT_TOKEN = 0.0001;
const WH_PER_OUTPUT_TOKEN = 0.0006;
const GRID_G_PER_KWH = 400;
const CHARS_PER_TOKEN = 4;

// --- Datacenter registry (mirroring grid-intensity.ts) ---
const SERVICE_REGIONS = {
  claude: [
    { provider: 'aws', region: 'us-east-1' },
    { provider: 'aws', region: 'us-west-2' },
  ],
  chatgpt: [
    { provider: 'azure', region: 'eastus' },
    { provider: 'azure', region: 'eastus2' },
    { provider: 'azure', region: 'southcentralus' },
    { provider: 'azure', region: 'westus' },
  ],
  gemini: [
    { provider: 'gcp', region: 'us-central1' },
    { provider: 'gcp', region: 'us-east4' },
    { provider: 'gcp', region: 'us-west4' },
  ],
};

// --- Helpers ---
function cacheKey(dc) {
  return `${dc.provider}:${dc.region}`;
}

function estimateTokens(chars) {
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

function whFromTokens(inputTokens, outputTokens) {
  return inputTokens * WH_PER_INPUT_TOKEN + outputTokens * WH_PER_OUTPUT_TOKEN;
}

function whToGCO2(wh, gridIntensity) {
  return (wh / 1000) * gridIntensity;
}

// --- API fetch (mirrors fetchIntensity in grid-intensity.ts) ---
async function fetchIntensity(dc) {
  const url = `${API_BASE}/carbon-intensity/latest?dataCenterProvider=${dc.provider}&dataCenterRegion=${dc.region}`;
  const resp = await fetch(url, {
    headers: { 'auth-token': API_TOKEN },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${dc.provider}/${dc.region}`);
  }
  const data = await resp.json();
  if (typeof data.carbonIntensity !== 'number') {
    throw new Error(`No carbonIntensity in response for ${dc.provider}/${dc.region}`);
  }
  return data;
}

// --- Test runner ---
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function run() {
  console.log('=== Integration Test: Electricity Maps API → gCO₂ Pipeline ===\n');

  // -----------------------------------------------------------------------
  // Test 1: Fetch carbon intensity for all datacenter regions
  // -----------------------------------------------------------------------
  console.log('1. Fetching carbon intensity for all datacenter regions...\n');

  const cache = {};
  const allRegions = Object.values(SERVICE_REGIONS).flat();

  for (const dc of allRegions) {
    try {
      const data = await fetchIntensity(dc);
      cache[cacheKey(dc)] = data.carbonIntensity;

      assert(data.carbonIntensity > 0, `${dc.provider}/${dc.region}: ${data.carbonIntensity} gCO₂/kWh (zone: ${data.zone})`);
      assert(data.carbonIntensity < 1500, `${dc.provider}/${dc.region}: value is within sane range (<1500)`);
      assert(typeof data.zone === 'string' && data.zone.length > 0, `${dc.provider}/${dc.region}: has zone identifier "${data.zone}"`);
      assert(typeof data.datetime === 'string', `${dc.provider}/${dc.region}: has datetime`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${dc.provider}/${dc.region}: FETCH FAILED — ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Test 2: Compute per-service averages from fetched data
  // -----------------------------------------------------------------------
  console.log('\n2. Computing per-service average intensities from live data...\n');

  const serviceAverages = {};
  for (const [service, regions] of Object.entries(SERVICE_REGIONS)) {
    let sum = 0;
    let count = 0;
    for (const dc of regions) {
      const val = cache[cacheKey(dc)];
      if (val != null) {
        sum += val;
        count++;
      }
    }
    const avg = count > 0 ? sum / count : GRID_G_PER_KWH;
    serviceAverages[service] = avg;

    assert(count === regions.length, `${service}: got data for all ${regions.length} regions`);
    assert(avg > 0 && avg < 1000, `${service}: average intensity ${avg.toFixed(1)} g/kWh is reasonable`);
  }

  // -----------------------------------------------------------------------
  // Test 3: Full pipeline — conversation stats → gCO₂ using live intensities
  // -----------------------------------------------------------------------
  console.log('\n3. Full pipeline: conversation → gCO₂ with live grid data...\n');

  const conversation = {
    service: 'claude',
    humanChars: 2000,      // ~500 input tokens
    assistantChars: 16000, // ~4000 output tokens
  };

  const inTokens = estimateTokens(conversation.humanChars);
  const outTokens = estimateTokens(conversation.assistantChars);
  const wh = whFromTokens(inTokens, outTokens);

  assert(inTokens === 500, `Input tokens: ${inTokens} (expect 500)`);
  assert(outTokens === 4000, `Output tokens: ${outTokens} (expect 4000)`);
  assert(Math.abs(wh - 2.45) < 0.001, `Energy: ${wh} Wh (expect 2.45)`);

  for (const service of ['claude', 'chatgpt', 'gemini']) {
    const intensity = serviceAverages[service];
    const gCO2 = whToGCO2(wh, intensity);
    const gCO2_fallback = whToGCO2(wh, GRID_G_PER_KWH);

    assert(gCO2 > 0, `${service}: gCO₂ = ${gCO2.toFixed(4)} (intensity: ${intensity.toFixed(0)} g/kWh)`);
    assert(gCO2 !== gCO2_fallback || intensity === GRID_G_PER_KWH,
      `${service}: live value (${gCO2.toFixed(4)}) differs from fallback (${gCO2_fallback.toFixed(4)})`);
  }

  // -----------------------------------------------------------------------
  // Test 4: Verify services have different intensities (they use different grids)
  // -----------------------------------------------------------------------
  console.log('\n4. Verifying provider differentiation...\n');

  const intensities = Object.values(serviceAverages);
  const allSame = intensities.every((v) => v === intensities[0]);
  assert(!allSame, `Services have different average intensities (not all identical)`);

  // Oregon (hydro) should pull Claude's average below Iowa (coal/wind) for Gemini
  // This isn't guaranteed at every hour, so we just check they're not wildly off
  for (const [service, avg] of Object.entries(serviceAverages)) {
    assert(avg >= 20 && avg <= 800, `${service}: ${avg.toFixed(0)} g/kWh is within plausible US range [20, 800]`);
  }

  // -----------------------------------------------------------------------
  // Test 5: Edge cases
  // -----------------------------------------------------------------------
  console.log('\n5. Edge cases...\n');

  assert(whToGCO2(0, 300) === 0, 'Zero Wh → zero gCO₂');
  assert(whFromTokens(0, 0) === 0, 'Zero tokens → zero Wh');
  assert(estimateTokens(0) === 0, 'Zero chars → zero tokens');
  assert(estimateTokens(1) === 1, '1 char → 1 token (ceil)');

  const tinyWh = whFromTokens(1, 1);
  const tinyGCO2 = whToGCO2(tinyWh, serviceAverages.claude);
  assert(tinyGCO2 > 0 && tinyGCO2 < 0.001, `Tiny conversation (1 in + 1 out token): ${tinyGCO2.toFixed(6)} gCO₂`);

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
