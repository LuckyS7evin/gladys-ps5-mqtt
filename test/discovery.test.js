import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseStaticIps } from '../src/config.js';
import { discoverConsoles } from '../src/discovery.js';
import { fakeNetwork, PS4_ID, ps4Reply, PS5_ID, ps5Reply, scanResult } from './helpers.js';

const noWait = async () => {};

test('static IPs are split and validated', () => {
  assert.deepEqual(parseStaticIps('192.168.1.42, 10.0.0.7;192.168.1.42 nope 300.1.1.1'), [
    '192.168.1.42',
    '10.0.0.7',
  ]);
  assert.deepEqual(parseStaticIps(undefined), []);
});

test('the config is normalized', () => {
  const config = normalizeConfig({ psn_poll_interval: '5', include_ps4: 'true', npsso: ' abc ' });
  assert.equal(config.psn_poll_interval, 10, 'the PSN rate limit floor applies');
  assert.equal(config.include_ps4, true);
  assert.equal(config.npsso, 'abc');
  assert.equal(config.psn_preferred_console, null);
  assert.deepEqual(normalizeConfig().static_ips, []);
});

test('consoles found by the core broadcast scan are returned', async () => {
  const gladys = createFakeGladys({
    scanResults: { 'udp-active-broadcast': [scanResult(ps5Reply(), '192.168.1.42')] },
  });
  const consoles = await discoverConsoles(gladys, normalizeConfig(), { sleep: noWait });

  assert.equal(consoles.length, 1);
  assert.equal(consoles[0].id, PS5_ID);
  assert.equal(consoles[0].address, '192.168.1.42');
  const [scan] = gladys.fake.scans;
  assert.equal(scan.type, 'udp-active-broadcast');
  assert.equal(scan.port, 9302);
  assert.equal(
    Buffer.from(scan.payload_base64, 'base64').toString(),
    'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n',
  );
});

test('PS4 consoles are scanned and kept only when enabled', async () => {
  const scanResults = {
    'udp-active-broadcast': [
      scanResult(ps5Reply(), '192.168.1.42'),
      scanResult(ps4Reply(), '192.168.1.43'),
    ],
  };
  const withoutPs4 = createFakeGladys({ scanResults });
  const ps5Only = await discoverConsoles(withoutPs4, normalizeConfig(), { sleep: noWait });
  assert.deepEqual(
    ps5Only.map((info) => info.id),
    [PS5_ID],
  );
  assert.equal(withoutPs4.fake.scans.length, 1, 'no PS4 scan');

  const withPs4 = createFakeGladys({ scanResults });
  const waits = [];
  const all = await discoverConsoles(withPs4, normalizeConfig({ include_ps4: true }), {
    sleep: async (ms) => waits.push(ms),
  });
  assert.deepEqual(all.map((info) => info.id).sort(), [PS4_ID, PS5_ID].sort());
  assert.deepEqual(
    withPs4.fake.scans.map((scan) => scan.port),
    [9302, 987],
  );
  assert.ok(waits[0] >= 10_000, 'the second scan waits for the core rate limit');
});

test('static IPs are queried in unicast and merged by host-id', async () => {
  const gladys = createFakeGladys({
    scanResults: { 'udp-active-broadcast': [scanResult(ps5Reply(), '192.168.1.42')] },
  });
  const network = fakeNetwork({ '192.168.1.42': ps5Reply(), '10.0.0.9': null });
  const config = normalizeConfig({ static_ips: '192.168.1.42, 10.0.0.9' });
  const consoles = await discoverConsoles(gladys, config, { query: network.query, sleep: noWait });

  assert.equal(consoles.length, 1, 'the same console found twice is listed once');
  assert.deepEqual(
    network.calls.map((call) => call.ip),
    ['192.168.1.42', '10.0.0.9'],
  );
});

test('a failing scan does not fail the discovery', async (t) => {
  const gladys = createFakeGladys();
  t.mock.method(gladys, 'scanNetwork', async () => {
    throw new Error('429 TOO_MANY_REQUESTS');
  });
  const network = fakeNetwork({ '192.168.1.42': ps5Reply() });
  const consoles = await discoverConsoles(gladys, normalizeConfig({ static_ips: '192.168.1.42' }), {
    query: network.query,
    sleep: noWait,
  });
  assert.equal(consoles.length, 1);
});
