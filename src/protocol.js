// -----------------------------------------------------------------------------
// PlayStation discovery protocol (DDP), the part we speak ourselves.
//
// Every PS4/PS5 answers a `SRCH` datagram on its discovery port with an
// HTTP-like text reply: the status line tells whether it is awake (`200 Ok`)
// or in rest mode (`620 Server Standby`), the headers carry its identity
// (`host-id`, `host-name`, `host-type`, `system-version`...). It is the same
// exchange playactor and ps5-mqtt use, small enough to keep in the container
// instead of spawning a playactor process on every poll.
//
// Pure functions only: the sockets live in src/network.js, the broadcast is
// emitted by the Gladys core (src/discovery.js).
// -----------------------------------------------------------------------------

export const CONSOLE_TYPES = { PS4: 'PS4', PS5: 'PS5' };

// UDP port each console type listens to for discovery and wake requests.
export const DISCOVERY_PORTS = {
  [CONSOLE_TYPES.PS4]: 987,
  [CONSOLE_TYPES.PS5]: 9302,
};

// Protocol version sent in the request, per console type.
const DISCOVERY_VERSIONS = {
  [CONSOLE_TYPES.PS4]: '00020020',
  [CONSOLE_TYPES.PS5]: '00030010',
};

export const POWER_STATUS = { AWAKE: 'AWAKE', STANDBY: 'STANDBY' };

const STATUS_CODE_STANDBY = '620';

/**
 * Build the `SRCH` request for a console type.
 * @param {'PS4' | 'PS5'} type
 * @returns {Buffer}
 */
export function buildSearchRequest(type) {
  const version = DISCOVERY_VERSIONS[type];
  if (!version) {
    throw new Error(`Unknown console type: ${type}`);
  }
  return Buffer.from(`SRCH * HTTP/1.1\ndevice-discovery-protocol-version:${version}\n`);
}

/**
 * Parse a console reply to `SRCH`. Returns `null` for anything that is not a
 * console reply (another device answering on the port, our own request echoed
 * back by a broadcast, a truncated datagram).
 * @param {Buffer | string} raw
 * @param {string} address - IP the reply came from.
 * @returns {null | {
 *   id: string, name: string, type: 'PS4' | 'PS5', address: string,
 *   status: 'AWAKE' | 'STANDBY', systemVersion: string | undefined,
 *   hostRequestPort: number | undefined, runningAppName: string | undefined,
 *   runningAppTitleId: string | undefined,
 * }}
 */
export function parseSearchResponse(raw, address) {
  const lines = raw.toString('utf8').split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  if (!statusLine.startsWith('HTTP/')) {
    return null;
  }
  const code = statusLine.split(' ')[1];
  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  const type = headers['host-type']?.toUpperCase();
  if (!headers['host-id'] || !Object.values(CONSOLE_TYPES).includes(type)) {
    return null;
  }
  const hostRequestPort = Number.parseInt(headers['host-request-port'], 10);
  return {
    id: headers['host-id'],
    name: headers['host-name'] || type,
    type,
    address,
    status: code === STATUS_CODE_STANDBY ? POWER_STATUS.STANDBY : POWER_STATUS.AWAKE,
    systemVersion: headers['system-version'],
    hostRequestPort: Number.isNaN(hostRequestPort) ? undefined : hostRequestPort,
    // PS4 consoles name the running application in their reply; PS5 ones do not.
    runningAppName: headers['running-app-name'] || undefined,
    runningAppTitleId: headers['running-app-titleid'] || undefined,
  };
}

/**
 * The `IDiscoveredDevice` shape playactor expects for a registration, built
 * from a parsed reply.
 */
export function toPlayactorDevice(info) {
  return {
    address: { address: info.address, port: DISCOVERY_PORTS[info.type], family: 'IPv4' },
    hostRequestPort: info.hostRequestPort ?? 997,
    extras: {},
    discoveryVersion: DISCOVERY_VERSIONS[info.type],
    systemVersion: info.systemVersion,
    id: info.id,
    name: info.name,
    status: info.status,
    type: info.type,
  };
}
