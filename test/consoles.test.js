import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import {
  ACTIVITY_STATUS,
  buildDevice,
  ConsoleManager,
  coverImageKey,
  NO_GAME,
  SCENE_TRIGGERS,
} from '../src/consoles.js';
import { parseSearchResponse } from '../src/protocol.js';
import {
  fakeNetwork,
  fakePlayactor,
  HORIZON,
  PS4_ID,
  ps4Reply,
  PS5_ID,
  ps5Reply,
} from './helpers.js';

const PS5_IP = '192.168.1.42';
const PS4_IP = '192.168.1.43';

/**
 * A connected fake Gladys where the given consoles are already created, and
 * a ConsoleManager wired to stand-ins.
 */
async function setup({
  replies = { [PS5_IP]: ps5Reply() },
  created = [[ps5Reply(), PS5_IP]],
  config = {},
  playactor = fakePlayactor({ paired: [PS5_ID] }),
  discover,
  t,
} = {}) {
  const probe = createFakeGladys();
  const devices = created.map(([reply, ip]) => buildDevice(probe, parseSearchResponse(reply, ip)));
  const gladys = createFakeGladys({ devices });
  await gladys.connect();
  const network = fakeNetwork(replies);
  let clock = Date.parse('2026-10-18T10:00:00Z');
  const changes = [];
  const consoles = new ConsoleManager({
    gladys,
    playactor,
    getConfig: () => normalizeConfig(config),
    query: network.query,
    discover: discover ?? (async () => []),
    onChange: () => changes.push(Date.now()),
    now: () => clock,
  });
  t?.after(() => gladys.disconnect());
  return {
    gladys,
    consoles,
    network,
    playactor,
    changes,
    devices,
    ps5: devices[0],
    tick: (ms) => {
      clock += ms;
    },
    feature: (device, key) => `${device.external_id}:${key}`,
  };
}

test('Gladys accepts the discovery payload of a console', async () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, parseSearchResponse(ps5Reply(), PS5_IP));
  await gladys.publishDiscoveredDevices([device]);

  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(device.external_id, gladys.externalIds('console', PS5_ID).device);
  assert.equal(device.model, 'PlayStation 5');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['power', 'status', 'game'],
  );
  assert.equal(device.params.find((p) => p.name === 'IP_ADDRESS').value, PS5_IP);
});

test('every feature declares min and max', () => {
  // Gladys refuses to create a device whose features lack them (422,
  // "t_device_feature.min cannot be null") — the fake Gladys of the SDK does
  // not check it, so this test does.
  const device = buildDevice(createFakeGladys(), parseSearchResponse(ps5Reply(), PS5_IP));
  for (const feature of device.features) {
    assert.equal(typeof feature.min, 'number', `${feature.name}: min`);
    assert.equal(typeof feature.max, 'number', `${feature.name}: max`);
  }
});

test('a scan publishes every console found', async (t) => {
  const { gladys, consoles } = await setup({
    t,
    created: [],
    discover: async () => [parseSearchResponse(ps5Reply(), PS5_IP)],
  });
  await consoles.scan();
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].name, 'PS5-Salon');
});

test('a poll publishes the power state and the status', async (t) => {
  const { gladys, consoles, network, ps5, feature } = await setup({ t });

  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 1);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.IDLE);
  assert.equal(gladys.fake.lastState(feature(ps5, 'game')), NO_GAME);

  network.consoles[PS5_IP] = ps5Reply({ standby: true });
  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.STANDBY);
});

test('only changes are published, and they nudge the widgets', async (t) => {
  const { gladys, consoles, ps5, changes } = await setup({ t });
  await consoles.poll(ps5);
  const published = gladys.fake.states.length;
  await consoles.poll(ps5);
  assert.equal(gladys.fake.states.length, published, 'nothing changed, nothing sent');
  assert.equal(changes.length, 1);
});

test('an unreachable console is offline and triggers one rediscovery', async (t) => {
  let scans = 0;
  const { gladys, consoles, ps5, feature, tick } = await setup({
    t,
    replies: {},
    discover: async () => {
      scans += 1;
      return [parseSearchResponse(ps5Reply(), '192.168.1.99')];
    },
  });

  await consoles.poll(ps5);
  await consoles.rediscovery;
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.OFFLINE);
  assert.equal(scans, 1);
  assert.equal(consoles.targetOf(ps5).address, '192.168.1.99', 'the new address is used');

  await consoles.poll(ps5);
  assert.equal(scans, 1, 'the rediscovery has a cooldown');
  tick(6 * 60_000);
  consoles.known.clear();
  await consoles.poll(ps5);
  await consoles.rediscovery;
  assert.equal(scans, 2);
});

test('a poll answered by another console does not count', async (t) => {
  const { gladys, consoles, ps5, feature } = await setup({
    t,
    replies: { [PS5_IP]: ps4Reply() },
  });
  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.OFFLINE);
});

test('switching on wakes the console and confirms the state', async (t) => {
  const { gladys, consoles, ps5, feature, playactor, network, tick } = await setup({
    t,
    replies: { [PS5_IP]: ps5Reply({ standby: true }) },
    config: { login_passcode: '1234' },
  });
  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);

  const { completion } = await consoles.setPower(ps5, 1);
  await completion;
  assert.equal(playactor.calls[0].command, 'wake');
  assert.equal(playactor.calls[0].target.address, PS5_IP);
  assert.equal(playactor.calls[0].options.passcode, '1234');
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 1);

  // The console still answers "standby" while it boots: not shown.
  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 1);
  // Once the transition is over, the console's answer is the truth again.
  tick(31_000);
  network.consoles[PS5_IP] = ps5Reply({ standby: true });
  await consoles.poll(ps5);
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);
});

test('rest mode runs standby and ends the game', async (t) => {
  const { gladys, consoles, ps5, feature, playactor } = await setup({ t });
  await consoles.poll(ps5);
  await consoles.updateActivity(HORIZON);
  const { completion } = await consoles.setPower(ps5, 0);
  await completion;

  assert.equal(playactor.calls[0].command, 'standby');
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);
  assert.equal(gladys.fake.lastState(feature(ps5, 'game')), NO_GAME);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((event) => event.key),
    [SCENE_TRIGGERS.GAME_STARTED, SCENE_TRIGGERS.GAME_STOPPED],
  );
});

test('a console that is not paired refuses the command', async (t) => {
  const { consoles, ps5, playactor } = await setup({ t, playactor: fakePlayactor() });
  await assert.rejects(consoles.setPower(ps5, 1), /not paired yet/);
  assert.equal(playactor.calls.length, 0);
});

test('one power command at a time per console', async (t) => {
  const { consoles, ps5 } = await setup({ t });
  const first = await consoles.setPower(ps5, 1);
  await assert.rejects(consoles.setPower(ps5, 0), /already running/);
  await first.completion;
  const second = await consoles.setPower(ps5, 0);
  await second.completion;
});

test('a failed command puts the switch back', async (t) => {
  const playactor = fakePlayactor({ paired: [PS5_ID], fail: new Error('403') });
  const { gladys, consoles, ps5, feature } = await setup({
    t,
    playactor,
    replies: { [PS5_IP]: ps5Reply({ standby: true }) },
  });
  await consoles.poll(ps5);
  const before = gladys.fake.states.length;

  const { completion } = await consoles.setPower(ps5, 1);
  await assert.rejects(completion, /403/);
  assert.ok(gladys.fake.states.length > before, 'the known state is sent again');
  assert.equal(gladys.fake.lastState(feature(ps5, 'power')), 0);
});

test('the PSN activity goes to the awake console of its platform', async (t) => {
  const { gladys, consoles, ps5, feature, devices } = await setup({
    t,
    replies: { [PS5_IP]: ps5Reply(), [PS4_IP]: ps4Reply() },
    created: [
      [ps5Reply(), PS5_IP],
      [ps4Reply(), PS4_IP],
    ],
    config: { npsso: 'token' },
  });
  for (const device of devices) await consoles.poll(device);

  await consoles.updateActivity(HORIZON);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.PLAYING);
  assert.equal(gladys.fake.lastState(feature(ps5, 'game')), HORIZON.titleName);
  assert.equal(gladys.fake.lastState(feature(devices[1], 'status')), ACTIVITY_STATUS.IDLE);

  const [started] = gladys.fake.sceneEvents;
  assert.equal(started.key, SCENE_TRIGGERS.GAME_STARTED);
  assert.deepEqual(started.data, {
    device: ps5.external_id,
    title_name: HORIZON.titleName,
    title_id: HORIZON.titleId,
  });

  // The same title again: no new event.
  await consoles.updateActivity(HORIZON);
  assert.equal(gladys.fake.sceneEvents.length, 1);

  await consoles.updateActivity(null);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), ACTIVITY_STATUS.IDLE);
  assert.equal(gladys.fake.sceneEvents[1].key, SCENE_TRIGGERS.GAME_STOPPED);
  assert.equal(gladys.fake.sceneEvents[1].data.title_name, HORIZON.titleName);
});

test('the preferred console wins when several are awake', async (t) => {
  const otherReply = ps5Reply({ name: 'PS5-Bureau' }).replace(PS5_ID, 'AAAAAAAAAAAA');
  const probe = createFakeGladys();
  const preferred = probe.externalIds('console', 'AAAAAAAAAAAA').device;
  const { gladys, consoles, devices, feature } = await setup({
    t,
    replies: { [PS5_IP]: ps5Reply(), '192.168.1.44': otherReply },
    created: [
      [ps5Reply(), PS5_IP],
      [otherReply, '192.168.1.44'],
    ],
    config: { psn_preferred_console: preferred },
  });
  for (const device of devices) await consoles.poll(device);

  await consoles.updateActivity(HORIZON);
  assert.equal(gladys.fake.lastState(feature(devices[1], 'game')), HORIZON.titleName);
  assert.equal(gladys.fake.lastState(feature(devices[0], 'game')), NO_GAME);
});

test('no awake console, no game', async (t) => {
  const { gladys, consoles, ps5, feature } = await setup({
    t,
    replies: { [PS5_IP]: ps5Reply({ standby: true }) },
  });
  await consoles.poll(ps5);
  await consoles.updateActivity(HORIZON);
  assert.equal(gladys.fake.lastState(feature(ps5, 'game')), NO_GAME);
  assert.equal(gladys.fake.sceneEvents.length, 0);
});

test('a PS4 tells its running game without a PSN account', async (t) => {
  const { gladys, consoles, devices, feature } = await setup({
    t,
    replies: { [PS4_IP]: ps4Reply({ app: { name: 'Bloodborne', titleId: 'CUSA00900' } }) },
    created: [[ps4Reply(), PS4_IP]],
    playactor: fakePlayactor({ paired: [PS4_ID] }),
  });
  await consoles.poll(devices[0]);
  assert.equal(gladys.fake.lastState(feature(devices[0], 'game')), 'Bloodborne');
  assert.equal(gladys.fake.lastState(feature(devices[0], 'status')), ACTIVITY_STATUS.PLAYING);
});

test('the widget snapshot and the cover key', async (t) => {
  const { consoles, ps5 } = await setup({ t });
  await consoles.poll(ps5);
  await consoles.updateActivity(HORIZON);

  const snapshot = consoles.snapshot(ps5.external_id);
  assert.equal(snapshot.name, 'PS5-Salon');
  assert.equal(snapshot.status, ACTIVITY_STATUS.PLAYING);
  assert.equal(snapshot.powerFeature, `${ps5.external_id}:power`);
  assert.equal(consoles.snapshot('ext:unknown'), null);

  assert.equal(coverImageKey(HORIZON), 'cover-ppsa01521-00');
  assert.equal(consoles.activityByImageKey('cover-ppsa01521-00'), HORIZON);
  assert.equal(consoles.activityByImageKey('cover-other'), null);
});

test('the PSN loop leaves a console not polled yet to its first poll', async (t) => {
  const { gladys, consoles, ps5, feature } = await setup({ t });
  await consoles.updateActivity(null);
  assert.equal(gladys.fake.lastState(feature(ps5, 'status')), undefined);
});
