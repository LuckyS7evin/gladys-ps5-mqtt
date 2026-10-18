// The whole integration against the fake Gladys of the SDK: handlers wired
// by src/app.js, network parts replaced by stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { buildDevice, NO_GAME } from '../src/consoles.js';
import { parseSearchResponse } from '../src/protocol.js';
import { buildNowPlayingContent, coverUrl } from '../src/widgets.js';
import {
  fakeNetwork,
  fakePlayactor,
  fakePsn,
  HORIZON,
  PS5_ID,
  ps5Reply,
  scanResult,
  tempDir,
} from './helpers.js';

const PS5_IP = '192.168.1.42';
const PAIRING = {
  redirect_url: 'https://remoteplay.dl.playstation.net/remoteplay/redirect?code=abc123',
  pin: '1234 5678',
};

// The smallest valid PNG (1×1 px), what the cover download returns.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==',
  'base64',
);

async function start({
  config = {},
  replies = { [PS5_IP]: ps5Reply() },
  created = true,
  playactor = fakePlayactor({ paired: [PS5_ID] }),
  psn = fakePsn(),
  t,
} = {}) {
  const probe = createFakeGladys();
  const ps5 = buildDevice(probe, parseSearchResponse(ps5Reply(), PS5_IP));
  const gladys = createFakeGladys({
    config,
    devices: created ? [ps5] : [],
    scanResults: { 'udp-active-broadcast': [scanResult(ps5Reply(), PS5_IP)] },
  });
  const network = fakeNetwork(replies);
  const fetches = [];
  const app = registerHandlers(gladys, {
    dataDir: await tempDir(),
    playactor,
    psn,
    query: network.query,
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => PNG };
    },
  });
  await gladys.connect();
  t.after(async () => {
    app.stopPsn();
    await gladys.disconnect();
  });
  return { gladys, app, ps5, network, playactor, psn, fetches };
}

test('the Discovery tab lists the consoles found on the network', async (t) => {
  const { gladys } = await start({ t, created: false });
  await gladys.fake.scanRequest();
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.discoveredDevices[0].name, 'PS5-Salon');
});

test('connected without NPSSO: the integration reports itself connected', async (t) => {
  const { gladys } = await start({ t });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('Gladys polls a console and switches it to rest mode', async (t) => {
  const { gladys, ps5, playactor } = await start({ t });
  assert.deepEqual(await gladys.fake.poll(ps5), { success: true });
  assert.equal(gladys.fake.lastState(`${ps5.external_id}:power`), 1);

  const power = ps5.features.find((f) => f.external_id.endsWith(':power'));
  assert.deepEqual(await gladys.fake.setValue(ps5, power, 0), { success: true });
  // The command acks at once and runs in the background.
  await settle();
  assert.equal(playactor.calls[0].command, 'standby');
});

// Let the background power command finish.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('read-only features and unpaired consoles refuse commands', async (t) => {
  const { gladys, ps5 } = await start({ t, playactor: fakePlayactor() });
  const game = ps5.features.find((f) => f.external_id.endsWith(':game'));
  const refused = await gladys.fake.setValue(ps5, game, 'x');
  assert.equal(refused.success, false);
  assert.match(refused.error, /read-only/);

  const power = ps5.features.find((f) => f.external_id.endsWith(':power'));
  const unpaired = await gladys.fake.setValue(ps5, power, 1);
  assert.equal(unpaired.success, false);
  assert.match(unpaired.error, /not paired/);
});

test('the sign-in link action shows the URL', async (t) => {
  const { gladys } = await start({ t });
  const ack = await gladys.fake.action('psn_login_link', {});
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /https:\/\/auth\.example\/login/);
  assert.match(ack.data.message.fr, /https:\/\/auth\.example\/login/);
});

test('pairing registers with the awake console', async (t) => {
  const { gladys, ps5, playactor } = await start({ t, playactor: fakePlayactor() });
  const ack = await gladys.fake.action('pair_console', { device: ps5.external_id, ...PAIRING });

  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /is paired/);
  const [pairing] = playactor.calls;
  assert.equal(pairing.command, 'pair');
  assert.equal(pairing.info.id, PS5_ID);
  assert.deepEqual(pairing.pairing, { redirectUrl: PAIRING.redirect_url, pin: '12345678' });
  assert.equal(await playactor.hasCredentials(PS5_ID), true);
});

test('pairing explains what is wrong', async (t) => {
  const { gladys, ps5, network, playactor } = await start({ t, playactor: fakePlayactor() });
  const pair = (fields) =>
    gladys.fake.action('pair_console', { device: ps5.external_id, ...PAIRING, ...fields });

  assert.match((await pair({ redirect_url: 'https://example.com' })).data.message.en, /code=/);
  assert.match((await pair({ pin: '123' })).data.message.en, /8-digit/);
  assert.match((await pair({ device: 'ext:unknown' })).data.message.en, /Unknown console/);
  network.consoles[PS5_IP] = ps5Reply({ standby: true });
  assert.match((await pair({})).data.message.en, /must be switched on/);
  assert.equal(playactor.calls.length, 0);

  network.consoles[PS5_IP] = ps5Reply();
  playactor.pair = async () => {
    throw new Error('Timeout');
  };
  const failed = await pair({});
  assert.equal(failed.success, false);
  assert.match(failed.error, /Pairing failed \(Timeout\)/);
});

test('the PSN loop shows the game and fires the scene trigger', async (t) => {
  const psn = fakePsn({ activity: HORIZON });
  const { gladys, app, ps5 } = await start({ t, psn, config: { npsso: 'token' } });
  await gladys.fake.poll(ps5);
  await app.pollPsn();

  assert.equal(psn.connected, 'token');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.lastState(`${ps5.external_id}:game`), HORIZON.titleName);
  assert.equal(gladys.fake.sceneEvents.at(-1).key, 'game_started');

  psn.activity = null;
  await app.pollPsn();
  assert.equal(gladys.fake.lastState(`${ps5.external_id}:game`), NO_GAME);
  assert.equal(gladys.fake.sceneEvents.at(-1).key, 'game_stopped');
});

test('an NPSSO that cannot sign in is reported on the Configuration screen', async (t) => {
  const psn = fakePsn({ connectError: new Error('401') });
  const { gladys } = await start({ t, psn, config: { npsso: 'expired' } });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /NPSSO/);
});

test('a configuration update restarts the PSN loop', async (t) => {
  const psn = fakePsn();
  const { gladys } = await start({ t, psn });
  assert.equal(psn.connected, null);
  await gladys.fake.configUpdated({ npsso: 'fresh' });
  assert.equal(psn.connected, 'fresh');
  await gladys.fake.configUpdated({});
  assert.equal(psn.connected, null);
});

test('the PSN test action tells what is played', async (t) => {
  const psn = fakePsn({ activity: HORIZON });
  const { gladys, ps5 } = await start({ t, psn, config: { npsso: 'token' } });
  await gladys.fake.poll(ps5);
  const ack = await gladys.fake.action('test_psn', {});
  assert.match(ack.data.message.en, /Gamer: playing Horizon Forbidden West/);

  await gladys.fake.configUpdated({});
  const noToken = await gladys.fake.action('test_psn', {});
  assert.match(noToken.data.message.fr, /Aucun jeton NPSSO/);
});

test('the widget renders a console exactly as sent, cover included', async (t) => {
  const psn = fakePsn({ activity: HORIZON });
  const { gladys, app, ps5, fetches } = await start({ t, psn, config: { npsso: 'token' } });
  await gladys.fake.poll(ps5);
  await app.pollPsn();

  const ack = await gladys.fake.widgetGet('now_playing', {
    settings: { console: ps5.external_id },
  });
  const { content } = ack.data;
  assert.deepEqual(validateWidgetContent(content), []);
  const image = content.components.find((component) => component.type === 'image');
  assert.equal(image.key, 'cover-ppsa01521-00');
  const buttons = content.components.filter((component) => component.type === 'button');
  assert.deepEqual(
    buttons.map((button) => [button.device_feature, button.value]),
    [
      [`${ps5.external_id}:power`, 1],
      [`${ps5.external_id}:power`, 0],
    ],
  );

  const cover = await gladys.fake.widgetGetImage(image.key);
  assert.equal(cover.success, true);
  assert.equal(cover.data.image, PNG.toString('base64'));
  assert.match(fetches[0], /[?&]w=480/);

  const missing = await gladys.fake.widgetGetImage('cover-unknown');
  assert.equal(missing.success, false);
});

test('the widget empty state and offline console are valid contents', () => {
  assert.deepEqual(validateWidgetContent(buildNowPlayingContent(null)), []);
  const offline = buildNowPlayingContent({
    name: 'A console with a really long name that goes on',
    status: 'offline',
    activity: null,
    powerFeature: 'ext:test-integration:console:X:power',
  });
  assert.deepEqual(validateWidgetContent(offline), []);
  assert.equal(offline.components.filter((c) => c.type === 'image').length, 0);
});

test('only PlayStation image URLs get a width', () => {
  assert.equal(
    coverUrl('https://image.api.playstation.com/a.png'),
    'https://image.api.playstation.com/a.png?w=480',
  );
  assert.equal(coverUrl('https://example.com/a.png'), 'https://example.com/a.png');
});

test('the Dockerfile ships the playactor preload next to the code', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY src \.\/src/);
});
