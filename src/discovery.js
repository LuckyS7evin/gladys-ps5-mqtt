// -----------------------------------------------------------------------------
// Console discovery.
//
// The consoles only answer a `SRCH` request, in unicast towards the emitter.
// The container cannot broadcast to the LAN (bridge network), so the request
// is forged here and broadcast by the Gladys core — `scanNetwork` with the
// `udp-active-broadcast` type, on the ports declared in the manifest
// `network_discovery` field. The IPs typed in the configuration are queried
// directly in unicast, for the consoles a broadcast cannot reach.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { queryConsole } from './network.js';
import {
  buildSearchRequest,
  CONSOLE_TYPES,
  DISCOVERY_PORTS,
  parseSearchResponse,
} from './protocol.js';

const logger = createLogger({ name: 'discovery' });

const SCAN_TIMEOUT_SECONDS = 3;
// The core accepts one scan per 10 seconds per integration (429 beyond): the
// PS4 scan waits for the PS5 one to be out of the window.
const SCAN_RATE_LIMIT_MS = 10_500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanType(gladys, type) {
  try {
    const replies = await gladys.scanNetwork('udp-active-broadcast', {
      port: DISCOVERY_PORTS[type],
      payload: buildSearchRequest(type),
      timeoutSeconds: SCAN_TIMEOUT_SECONDS,
    });
    return replies
      .map(({ source_ip: ip, payload_base64: payload }) =>
        parseSearchResponse(Buffer.from(payload, 'base64'), ip),
      )
      .filter(Boolean);
  } catch (err) {
    // An older core (no mediated discovery), a refused or rate-limited scan:
    // the static IPs still work, so this never fails the whole discovery.
    logger.warn(`${type} broadcast scan failed: ${err.message}`);
    return [];
  }
}

async function queryStaticIp(ip, config, query) {
  const types = config.include_ps4 ? [CONSOLE_TYPES.PS5, CONSOLE_TYPES.PS4] : [CONSOLE_TYPES.PS5];
  for (const type of types) {
    const info = await query(ip, { type });
    if (info) return info;
  }
  logger.warn(`No console answered at ${ip}`);
  return null;
}

/**
 * Find the consoles: broadcast scan through the core plus the static IPs of
 * the configuration. Resolves one entry per console (by `host-id`).
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {{ query?: typeof queryConsole, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function discoverConsoles(
  gladys,
  config,
  { query = queryConsole, sleep = wait } = {},
) {
  const found = await scanType(gladys, CONSOLE_TYPES.PS5);
  if (config.include_ps4) {
    await sleep(SCAN_RATE_LIMIT_MS);
    found.push(...(await scanType(gladys, CONSOLE_TYPES.PS4)));
  }
  for (const ip of config.static_ips) {
    const info = await queryStaticIp(ip, config, query);
    if (info) found.push(info);
  }

  const byId = new Map();
  for (const info of found) {
    if (info.type === CONSOLE_TYPES.PS4 && !config.include_ps4) continue;
    byId.set(info.id, info);
  }
  logger.info(`Discovery found ${byId.size} console(s)`);
  return [...byId.values()];
}
