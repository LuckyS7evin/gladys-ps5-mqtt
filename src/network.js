// -----------------------------------------------------------------------------
// Unicast discovery query: "are you there, and are you awake?"
//
// The container sits on a bridge network: broadcasts do not cross it, unicast
// does, in both directions. Once a console's IP is known (Gladys scan or IP
// typed in the configuration), its state is read with a direct `SRCH`, from a
// fresh socket bound to an ephemeral port — the reply comes back through the
// NAT like any UDP answer.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { buildSearchRequest, DISCOVERY_PORTS, parseSearchResponse } from './protocol.js';

/**
 * Ask a console for its state. Resolves the parsed reply, or `null` when
 * nothing answered in time (console unplugged, wrong IP, deep power-off).
 * @param {string} ip
 * @param {{ type?: 'PS4' | 'PS5', timeoutMs?: number, port?: number }} [options] -
 *   `port` overrides the discovery port of the type (tests)
 */
export function queryConsole(ip, { type = 'PS5', timeoutMs = 2000, port } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (message, rinfo) => {
      if (rinfo.address !== ip) return;
      const info = parseSearchResponse(message, rinfo.address);
      if (info) finish(info);
    });
    socket.bind(0, () => {
      socket.send(buildSearchRequest(type), port ?? DISCOVERY_PORTS[type], ip, (err) => {
        if (err) finish(null);
      });
    });
  });
}
