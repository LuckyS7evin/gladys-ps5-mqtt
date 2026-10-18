// Shared fixtures: console replies and stand-ins for the network parts.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSearchResponse } from '../src/protocol.js';

export const PS5_ID = '70C881D600B0';
export const PS4_ID = '60E899D600B0';

export function ps5Reply({ standby = false, name = 'PS5-Salon' } = {}) {
  return [
    standby ? 'HTTP/1.1 620 Server Standby' : 'HTTP/1.1 200 Ok',
    `host-id:${PS5_ID}`,
    'host-type:PS5',
    `host-name:${name}`,
    'host-request-port:997',
    'device-discovery-protocol-version:00030010',
    'system-version:09400000',
    '',
  ].join('\n');
}

export function ps4Reply({ standby = false, app = null } = {}) {
  return [
    standby ? 'HTTP/1.1 620 Server Standby' : 'HTTP/1.1 200 Ok',
    `host-id:${PS4_ID}`,
    'host-type:PS4',
    'host-name:PS4-Chambre',
    'host-request-port:997',
    'device-discovery-protocol-version:00020020',
    'system-version:11000000',
    ...(app ? [`running-app-name:${app.name}`, `running-app-titleid:${app.titleId}`] : []),
    '',
  ].join('\n');
}

export const scanResult = (reply, ip) => ({
  source_ip: ip,
  source_port: 9302,
  payload_base64: Buffer.from(reply).toString('base64'),
});

/**
 * A fake LAN: `consoles` maps an IP to the reply it gives (a string, or null
 * for a console that does not answer).
 */
export function fakeNetwork(consoles = {}) {
  const calls = [];
  const query = async (ip, options) => {
    calls.push({ ip, ...options });
    const reply = consoles[ip];
    return reply ? parseSearchResponse(reply, ip) : null;
  };
  return { consoles, calls, query };
}

/** A playactor client that records the commands instead of running them. */
export function fakePlayactor({ paired = [], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    paired: new Set(paired),
    async hasCredentials(id) {
      return this.paired.has(id);
    },
    async wake(target, options) {
      calls.push({ command: 'wake', target, options });
      if (fail) throw fail;
    },
    async standby(target, options) {
      calls.push({ command: 'standby', target, options });
      if (fail) throw fail;
    },
    async loginUrl() {
      return 'https://auth.example/login';
    },
    async pair(info, pairing) {
      calls.push({ command: 'pair', info, pairing });
      if (fail) throw fail;
      this.paired.add(info.id);
    },
  };
}

/** A PSN client serving a scripted activity. */
export function fakePsn({ activity = null, connectError = null } = {}) {
  return {
    activity,
    connected: null,
    get account() {
      return this.connected && { accountId: '123', accountName: 'Gamer' };
    },
    async connect(npsso) {
      if (connectError) throw connectError;
      this.connected = npsso;
      return this.account;
    },
    disconnect() {
      this.connected = null;
    },
    async getActivity() {
      return this.activity;
    },
  };
}

export const HORIZON = {
  titleId: 'PPSA01521_00',
  titleName: 'Horizon Forbidden West',
  titleImage:
    'https://image.api.playstation.com/vulcan/ap/rnd/202010/2915/kifM3lnke5lExwRd96mIDojQ.png',
  platform: 'PS5',
};

export const tempDir = () => mkdtemp(join(tmpdir(), 'ps5-remote-play-'));
