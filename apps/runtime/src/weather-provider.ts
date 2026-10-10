import { localSkillResultStore } from './skill-result-store.js';
import { loadRuntimeEnv, localAppOrigins, localClaimExecution, localProviderConfig, serveLocalProvider } from './local-provider.js';
import { createAgentOsVaultSkillHandler } from './x402-vault.js';

loadRuntimeEnv();
const { programId, skill, port, resourceUrl } = localProviderConfig('WEATHER', 8788, '/weather');
const nwsUserAgent = process.env.AGENTOS_NWS_USER_AGENT?.trim() || 'AgentOS-Weather-Skill/0.1';
if (!nwsUserAgent || /[\r\n]/.test(nwsUserAgent)) throw new Error('AGENTOS_NWS_USER_AGENT must be a single nonempty line.');

const forecastUrls = new Map<string, { url: string; expiresAt: number }>();

function parseCoordinates(prompt: string): { latitude: number; longitude: number } {
  const match = prompt.trim().match(/^(?:weather\s+(?:at\s+)?)?(-?\d{1,2}(?:\.\d{1,4})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,4})?)\s*\??$/i);
  if (!match) throw new Error('Enter US coordinates as "weather 39.7456,-97.0892".');
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error('Weather coordinates are outside the valid latitude and longitude range.');
  }
  return { latitude, longitude };
}

async function nwsJson(url: URL): Promise<Record<string, unknown>> {
  if (url.protocol !== 'https:' || url.hostname !== 'api.weather.gov' || url.port || url.username || url.password || url.hash) {
    throw new Error('The weather service returned an invalid forecast URL.');
  }
  const response = await fetch(url, {
    headers: { accept: 'application/geo+json', 'user-agent': nwsUserAgent },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The weather service returned HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The weather service returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256_000) {
        await reader.cancel();
        throw new Error('The weather service response exceeded 256 KiB.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The weather service returned malformed JSON.');
  return data as Record<string, unknown>;
}

async function forecastUrlFor(prompt: string): Promise<{ url: URL; latitude: number; longitude: number }> {
  const { latitude, longitude } = parseCoordinates(prompt);
  const key = `${latitude},${longitude}`;
  const cached = forecastUrls.get(key);
  if (cached && cached.expiresAt > Date.now()) return { url: new URL(cached.url), latitude, longitude };
  const points = await nwsJson(new URL(`https://api.weather.gov/points/${latitude},${longitude}`));
  const properties = points.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties.forecast !== 'string') throw new Error('No US forecast is available for these coordinates.');
  const forecastUrl = new URL(properties.forecast);
  if (forecastUrl.protocol !== 'https:' || forecastUrl.hostname !== 'api.weather.gov' || forecastUrl.port || forecastUrl.search
    || !/^\/gridpoints\/[A-Za-z0-9]+\/\d+,\d+\/forecast\/?$/.test(forecastUrl.pathname)) {
    throw new Error('The weather service returned an unexpected forecast path.');
  }
  if (forecastUrls.size >= 100) forecastUrls.delete(forecastUrls.keys().next().value!);
  forecastUrls.set(key, { url: forecastUrl.toString(), expiresAt: Date.now() + 15 * 60_000 });
  return { url: forecastUrl, latitude, longitude };
}

async function getForecast(prompt: string) {
  const { url: forecastUrl, latitude, longitude } = await forecastUrlFor(prompt);
  const forecast = await nwsJson(forecastUrl);
  const forecastProperties = forecast.properties as Record<string, unknown> | undefined;
  const periods = forecastProperties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) throw new Error('The weather service returned no forecast periods.');
  const nextPeriods = periods.slice(0, 3).map((value) => {
    if (!value || typeof value !== 'object') throw new Error('The weather service returned an invalid forecast period.');
    const period = value as Record<string, unknown>;
    if (typeof period.name !== 'string' || typeof period.startTime !== 'string' || typeof period.shortForecast !== 'string'
      || typeof period.temperature !== 'number' || (period.temperatureUnit !== 'F' && period.temperatureUnit !== 'C')) {
      throw new Error('The weather service returned an incomplete forecast period.');
    }
    return {
      name: period.name,
      startsAt: period.startTime,
      temperature: period.temperature,
      unit: period.temperatureUnit,
      summary: period.shortForecast,
    };
  });
  return { source: 'US National Weather Service', sourceUrl: forecastUrl.toString(), retrievedAt: new Date().toISOString(), coordinates: { latitude, longitude }, periods: nextPeriods };
}

const handleSkill = createAgentOsVaultSkillHandler({
  programId,
  skill,
  resourceUrl,
  allowedOrigins: localAppOrigins(),
  claimExecution: localClaimExecution('weather'),
  resultStore: localSkillResultStore('weather', programId),
  validatePrompt: async (prompt) => { await forecastUrlFor(prompt); },
  execute: async ({ prompt }) => getForecast(prompt),
});

serveLocalProvider(port, '/weather', resourceUrl, handleSkill);
