import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { queryConsole } from '../src/network.js';
import {
  buildSearchRequest,
  parseSearchResponse,
  POWER_STATUS,
  toPlayactorDevice,
} from '../src/protocol.js';
import { PS4_ID, PS5_ID, ps4Reply, ps5Reply } from './helpers.js';

test('the SRCH request carries the protocol version of the console type', () => {
  assert.equal(
    buildSearchRequest('PS5').toString(),
    'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n',
  );
  assert.equal(
    buildSearchRequest('PS4').toString(),
    'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n',
  );
  assert.throws(() => buildSearchRequest('PS3'), /Unknown console type/);
});

test('an awake PS5 reply is parsed', () => {
  assert.deepEqual(parseSearchResponse(Buffer.from(ps5Reply()), '192.168.1.42'), {
    id: PS5_ID,
    name: 'PS5-Salon',
    type: 'PS5',
    address: '192.168.1.42',
    status: POWER_STATUS.AWAKE,
    systemVersion: '09400000',
    hostRequestPort: 997,
    runningAppName: undefined,
    runningAppTitleId: undefined,
  });
});

test('the 620 status means rest mode', () => {
  const info = parseSearchResponse(ps5Reply({ standby: true }), '192.168.1.42');
  assert.equal(info.status, POWER_STATUS.STANDBY);
});

test('a PS4 reply names its running application', () => {
  const info = parseSearchResponse(
    ps4Reply({ app: { name: 'Bloodborne', titleId: 'CUSA00900' } }),
    '192.168.1.43',
  );
  assert.equal(info.id, PS4_ID);
  assert.equal(info.type, 'PS4');
  assert.equal(info.runningAppName, 'Bloodborne');
  assert.equal(info.runningAppTitleId, 'CUSA00900');
});

test('anything but a console reply is ignored', () => {
  assert.equal(parseSearchResponse(buildSearchRequest('PS5'), '192.168.1.42'), null);
  assert.equal(parseSearchResponse('HTTP/1.1 200 Ok\nhost-type:PS5\n', '192.168.1.42'), null);
  assert.equal(parseSearchResponse('HTTP/1.1 200 Ok\nhost-id:X\nhost-type:XBOX\n', 'x'), null);
  assert.equal(parseSearchResponse('', '192.168.1.42'), null);
});

test('the playactor device shape is built from a reply', () => {
  const device = toPlayactorDevice(parseSearchResponse(ps5Reply(), '192.168.1.42'));
  assert.deepEqual(device.address, { address: '192.168.1.42', port: 9302, family: 'IPv4' });
  assert.equal(device.discoveryVersion, '00030010');
  assert.equal(device.id, PS5_ID);
  assert.equal(device.status, 'AWAKE');
  assert.equal(device.hostRequestPort, 997);
});

test('queryConsole reads a console over unicast UDP', async (t) => {
  // A fake console on the loopback interface.
  const fakeConsole = dgram.createSocket('udp4');
  t.after(() => fakeConsole.close());
  fakeConsole.on('message', (message, rinfo) => {
    if (message.toString().startsWith('SRCH')) {
      fakeConsole.send(ps5Reply({ standby: true }), rinfo.port, rinfo.address);
    }
  });
  fakeConsole.bind(0, '127.0.0.1');
  await once(fakeConsole, 'listening');

  const info = await queryConsole('127.0.0.1', { port: fakeConsole.address().port });
  assert.equal(info.id, PS5_ID);
  assert.equal(info.status, POWER_STATUS.STANDBY);
});

test('queryConsole resolves null when nothing answers', async (t) => {
  const silent = dgram.createSocket('udp4');
  t.after(() => silent.close());
  silent.bind(0, '127.0.0.1');
  await once(silent, 'listening');
  assert.equal(
    await queryConsole('127.0.0.1', { port: silent.address().port, timeoutMs: 100 }),
    null,
  );
});
