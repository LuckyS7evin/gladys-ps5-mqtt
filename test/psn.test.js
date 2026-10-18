import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createPsnClient, parsePresence } from '../src/psn.js';
import { tempDir } from './helpers.js';

const presence = (overrides = {}) => ({
  basicPresence: {
    availability: 'availableToPlay',
    primaryPlatformInfo: { onlineStatus: 'online', platform: 'PS5', lastOnlineDate: '' },
    gameTitleInfoList: [
      {
        npTitleId: 'PPSA01521_00',
        titleName: 'Horizon Forbidden West',
        format: 'PS5',
        launchPlatform: 'PS5',
        conceptIconUrl: 'https://image.api.playstation.com/cover.png',
      },
    ],
    ...overrides,
  },
});

const tokens = (suffix) => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  expiresIn: 3600,
  refreshTokenExpiresIn: 5_184_000,
});

function fakeApi() {
  const calls = [];
  let refreshCount = 0;
  return {
    calls,
    async exchangeNpssoForCode(npsso) {
      calls.push(['npsso', npsso]);
      return 'code';
    },
    async exchangeCodeForAccessToken() {
      calls.push(['code']);
      return tokens('initial');
    },
    async exchangeRefreshTokenForAuthTokens(refreshToken) {
      calls.push(['refresh', refreshToken]);
      refreshCount += 1;
      return tokens(`refreshed-${refreshCount}`);
    },
    async getProfileFromUserName(auth, name) {
      calls.push(['profile', auth.accessToken, name]);
      return { profile: { accountId: '42', onlineId: 'Gamer' } };
    },
    async getBasicPresence(auth, accountId) {
      calls.push(['presence', auth.accessToken, accountId]);
      return presence();
    },
  };
}

test('a presence is reduced to the title being played', () => {
  assert.deepEqual(parsePresence(presence()), {
    titleId: 'PPSA01521_00',
    titleName: 'Horizon Forbidden West',
    titleImage: 'https://image.api.playstation.com/cover.png',
    platform: 'PS5',
  });
  assert.equal(parsePresence(presence({ gameTitleInfoList: [] })), null);
  assert.equal(
    parsePresence(presence({ primaryPlatformInfo: { onlineStatus: 'offline', platform: 'PS5' } })),
    null,
  );
  assert.equal(parsePresence(undefined), null);
});

test('a PS4 game launched on a PS5 is a PS5 activity', () => {
  const activity = parsePresence(
    presence({
      gameTitleInfoList: [
        { npTitleId: 'CUSA1', titleName: 'Old game', format: 'ps4', launchPlatform: 'PS5' },
      ],
    }),
  );
  assert.equal(activity.platform, 'PS5');
});

test('signing in exchanges the NPSSO and persists the tokens privately', async () => {
  const dataDir = await tempDir();
  const api = fakeApi();
  const psn = createPsnClient({ dataDir, api });

  assert.deepEqual(await psn.connect('my-npsso'), { accountId: '42', accountName: 'Gamer' });
  const stored = JSON.parse(await readFile(`${dataDir}/psn-auth.json`, 'utf8'));
  assert.equal(stored.accountId, '42');
  assert.equal(stored.authInfo.refreshToken, 'refresh-initial');
  assert.ok(!JSON.stringify(stored).includes('my-npsso'), 'the NPSSO itself is not stored');
  assert.equal((await stat(`${dataDir}/psn-auth.json`)).mode & 0o777, 0o600);

  const activity = await psn.getActivity();
  assert.equal(activity.titleName, 'Horizon Forbidden West');
  assert.deepEqual(api.calls.at(-1), ['presence', 'access-initial', '42']);
});

test('a restart reuses the persisted tokens instead of the NPSSO', async () => {
  const dataDir = await tempDir();
  let clock = 1_000_000;
  await createPsnClient({ dataDir, api: fakeApi(), now: () => clock }).connect('my-npsso');

  clock += 2 * 3600 * 1000; // the access token expired, not the refresh token
  const api = fakeApi();
  const psn = createPsnClient({ dataDir, api, now: () => clock });
  await psn.connect('my-npsso');
  assert.deepEqual(
    api.calls.map(([name]) => name),
    ['refresh'],
  );
  await psn.getActivity();
  assert.deepEqual(api.calls.at(-1), ['presence', 'access-refreshed-1', '42']);
});

test('another NPSSO signs in again', async () => {
  const dataDir = await tempDir();
  await createPsnClient({ dataDir, api: fakeApi() }).connect('old-npsso');
  const api = fakeApi();
  await createPsnClient({ dataDir, api }).connect('new-npsso');
  assert.deepEqual(api.calls[0], ['npsso', 'new-npsso']);
});

test('expired refresh tokens fall back to the NPSSO', async () => {
  const dataDir = await tempDir();
  let clock = 1_000_000;
  const api = fakeApi();
  const psn = createPsnClient({ dataDir, api, now: () => clock });
  await psn.connect('my-npsso');
  clock += 61 * 24 * 3600 * 1000;
  await psn.getActivity();
  assert.deepEqual(
    api.calls.slice(-3).map(([name]) => name),
    ['npsso', 'code', 'presence'],
  );
});

test('reading the activity requires a sign-in', async () => {
  const psn = createPsnClient({ dataDir: await tempDir(), api: fakeApi() });
  await assert.rejects(psn.getActivity(), /not connected/);
  assert.equal(psn.account, null);
});
