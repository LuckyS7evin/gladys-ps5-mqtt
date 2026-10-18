import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  buildCommandArgs,
  createPlayactorClient,
  explainFailure,
  validatePasscode,
} from '../src/playactor.js';
import { PS5_ID, tempDir } from './helpers.js';

const target = { id: PS5_ID, name: 'PS5-Salon', address: '192.168.1.42', type: 'PS5' };

test('power commands target the console by IP, without interactive sign-in', () => {
  assert.deepEqual(
    buildCommandArgs('wake', target, { credentialsPath: '/data/credentials.json' }),
    [
      'wake',
      '--ip',
      '192.168.1.42',
      '--timeout',
      '5000',
      '--connect-timeout',
      '5000',
      '--no-open-urls',
      '--no-auth',
      '--ps5',
      '-c',
      '/data/credentials.json',
    ],
  );
  const standby = buildCommandArgs(
    'standby',
    { ...target, type: 'PS4' },
    { credentialsPath: '/data/credentials.json', passcode: 'up up down' },
  );
  assert.ok(standby.includes('--ps4'));
  assert.deepEqual(standby.slice(-2), ['--pass-code', 'up up down']);
  assert.equal(standby[standby.indexOf('--timeout') + 1], '10000');
});

test('a passcode is digits or key names only', () => {
  assert.equal(validatePasscode('1234'), '1234');
  assert.equal(validatePasscode(''), '');
  assert.throws(() => validatePasscode('12; rm -rf /'), /digits or key names/);
});

test('playactor failures are explained', () => {
  assert.equal(explainFailure({ code: null, killed: true, stderr: '' }).code, 'TIMEOUT');
  assert.equal(explainFailure({ code: 4, stderr: '' }).code, 'PASSCODE_NEEDED');
  assert.equal(explainFailure({ code: 5, stderr: '' }).code, 'PASSCODE_UNMATCHED');
  assert.equal(
    explainFailure({ code: 1, stderr: 'Error: Unable to locate device: PS5 device at x' }).code,
    'NOT_FOUND',
  );
  assert.equal(
    explainFailure({ code: 1, stderr: 'HTTPError: Response code 403 (Forbidden)' }).code,
    'FORBIDDEN',
  );
  const generic = explainFailure({
    code: 1,
    stderr: 'Error: Something odd\n    at Foo (/app/x.js:1:1)\n',
  });
  assert.equal(generic.message, 'Something odd');
});

test('wake and standby run the CLI and reject on a non-zero exit', async () => {
  const dataDir = await tempDir();
  const runs = [];
  let result = { code: 0, stdout: '', stderr: '' };
  const client = createPlayactorClient({
    dataDir,
    run: async (args, options) => {
      runs.push({ args, options });
      return result;
    },
  });

  await client.wake(target, { passcode: '1234' });
  assert.equal(runs[0].args[0], 'wake');
  assert.ok(runs[0].args.includes(`${dataDir}/credentials.json`));
  assert.equal(runs[0].options.dataDir, dataDir);
  assert.ok(runs[0].options.timeoutMs > 10_000);

  result = { code: 4, stdout: '', stderr: '' };
  await assert.rejects(client.standby(target), /passcode/);
  assert.ok(runs[1].options.timeoutMs >= 25_000, 'standby gets the long handshake timeout');
});

test('pairing state is read from the credentials file', async () => {
  const dataDir = await tempDir();
  const client = createPlayactorClient({ dataDir });
  assert.equal(await client.hasCredentials(PS5_ID), false, 'no file yet');
  await writeFile(`${dataDir}/credentials.json`, JSON.stringify({ [PS5_ID]: {} }));
  assert.equal(await client.hasCredentials(PS5_ID), true);
  assert.equal(await client.hasCredentials('OTHER'), false);
});

test('the sign-in link is the Remote Play OAuth URL, obtained offline', async () => {
  const client = createPlayactorClient({ dataDir: await tempDir() });
  const url = new URL(await client.loginUrl());
  assert.equal(url.hostname, 'auth.api.sonyentertainmentnetwork.com');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://remoteplay.dl.playstation.net/remoteplay/redirect',
  );
});
