// -----------------------------------------------------------------------------
// Remote Play operations, through playactor (https://github.com/dhleong/playactor).
//
// - wake / standby run the playactor CLI in a child process, like ps5-mqtt
//   does: the Remote Play session needs the keep-alive shim of
//   ./playactor-preload.cjs, which must not leak into the SDK's own sockets,
//   and a hung handshake is killed with its process instead of pinning ours;
// - the pairing (PSN sign-in + PIN of the console) runs in-process: it is a
//   one-shot request/response exchange, driven by the manifest action.
//
// The credentials playactor obtains are stored in /data/credentials.json, the
// one writable volume of the container.
// -----------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@gladysassistant/integration-sdk';
import { toPlayactorDevice } from './protocol.js';

const logger = createLogger({ name: 'playactor' });
const require = createRequire(import.meta.url);

const PRELOAD_PATH = fileURLToPath(new URL('./playactor-preload.cjs', import.meta.url));

// Standby needs the full Remote Play handshake (discovery, session, login,
// passcode, then the request itself): the process timeout must exceed the sum
// of the discovery and connection timeouts, or a slow but healthy handshake is
// killed mid-flight (ps5-mqtt #675).
const TIMEOUTS = {
  wake: { discovery: 5000, connect: 5000, process: 15000 },
  standby: { discovery: 10000, connect: 10000, process: 25000 },
};

// playactor CLI exit codes (playactor/dist/cli/exit-codes.js).
const EXIT_CODES = { DEVICE_NOT_FOUND: 2, PASSCODE_NEEDED: 4, PASSCODE_UNMATCHED: 5 };

export class PlayactorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlayactorError';
    this.code = code;
  }
}

/**
 * Check a profile passcode before it reaches the command line: digits, or
 * key names separated by spaces ("up up down down"), as playactor accepts.
 */
export function validatePasscode(passcode) {
  if (passcode && !/^[A-Za-z0-9 ]+$/.test(passcode)) {
    throw new PlayactorError(
      'The passcode must be digits or key names separated by spaces.',
      'INVALID_PASSCODE',
    );
  }
  return passcode;
}

/**
 * Arguments of a playactor power command (`wake` or `standby`).
 * @param {'wake' | 'standby'} command
 * @param {{ address: string, type: 'PS4' | 'PS5' }} target
 * @param {{ credentialsPath: string, passcode?: string }} options
 */
export function buildCommandArgs(command, target, { credentialsPath, passcode }) {
  const timeouts = TIMEOUTS[command];
  const args = [
    command,
    '--ip',
    target.address,
    '--timeout',
    String(timeouts.discovery),
    '--connect-timeout',
    String(timeouts.connect),
    '--no-open-urls',
    '--no-auth',
    target.type === 'PS4' ? '--ps4' : '--ps5',
    '-c',
    credentialsPath,
  ];
  if (validatePasscode(passcode)) {
    args.push('--pass-code', passcode);
  }
  return args;
}

/**
 * Turn a failed playactor run into a message a user can act on.
 */
export function explainFailure({ code, stderr, killed }) {
  if (killed) {
    return new PlayactorError('The console did not answer in time.', 'TIMEOUT');
  }
  if (code === EXIT_CODES.DEVICE_NOT_FOUND || /Unable to locate device/.test(stderr)) {
    return new PlayactorError('The console was not found at its address.', 'NOT_FOUND');
  }
  if (code === EXIT_CODES.PASSCODE_NEEDED) {
    return new PlayactorError(
      'The PlayStation profile is protected by a passcode: set it in the configuration.',
      'PASSCODE_NEEDED',
    );
  }
  if (code === EXIT_CODES.PASSCODE_UNMATCHED) {
    return new PlayactorError('The configured passcode is wrong.', 'PASSCODE_UNMATCHED');
  }
  if (/\b403\b/.test(stderr)) {
    return new PlayactorError(
      'The console refused the Remote Play session (403): check the Remote Play settings of the console, or pair it again.',
      'FORBIDDEN',
    );
  }
  // playactor prints the error then its stack trace: keep the message line.
  const lines = stderr.split('\n').map((line) => line.trim());
  const errorLine = lines.find((line) => /^\w*Error:/.test(line));
  const detail = errorLine?.replace(/^\w*Error:\s*/, '') ?? lines.find(Boolean);
  return new PlayactorError(detail || `playactor exited with code ${code}`, 'FAILED');
}

function runCli(args, { timeoutMs, dataDir }) {
  const cliPath = require.resolve('playactor/dist/cli/index.js');
  const env = { ...process.env, HOME: dataDir, NODE_NO_WARNINGS: '1' };
  // The SDK's own DEBUG patterns must not turn on playactor's debug output.
  delete env.DEBUG;
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require "${PRELOAD_PATH}"`]
    .filter(Boolean)
    .join(' ');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          killed: Boolean(err?.killed),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

// Thrown by the login hook to stop playactor's OAuth flow once it handed the
// sign-in URL over: nothing else is needed to show the link to the user.
class LoginUrlCaptured extends Error {
  constructor(url) {
    super('login url captured');
    this.url = url;
  }
}

function loadPlayactorCredentials() {
  return {
    CredentialManager: require('playactor/dist/credentials').CredentialManager,
    DiskCredentialsStorage: require('playactor/dist/credentials/disk-storage')
      .DiskCredentialsStorage,
    OauthCredentialRequester: require('playactor/dist/credentials/oauth/requester')
      .OauthCredentialRequester,
    WriteOnlyStorage: require('playactor/dist/credentials/write-only-storage').WriteOnlyStorage,
  };
}

function playactorIo(pin) {
  return {
    logError: (err) => logger.debug(`playactor: ${err?.message ?? err}`),
    logInfo: (message) => logger.debug(`playactor: ${message}`),
    logResult: () => {},
    prompt: async () => pin,
  };
}

/**
 * @param {{ dataDir: string, run?: typeof runCli }} options
 */
export function createPlayactorClient({ dataDir, run = runCli }) {
  const credentialsPath = `${dataDir}/credentials.json`;

  async function power(command, target, passcode) {
    const args = buildCommandArgs(command, target, { credentialsPath, passcode });
    logger.info(`${command} -> ${target.name ?? target.id} (${target.address})`);
    const result = await run(args, { timeoutMs: TIMEOUTS[command].process, dataDir });
    if (result.code !== 0) {
      throw explainFailure(result);
    }
  }

  return {
    credentialsPath,

    /** Whether the console was paired (playactor holds credentials for it). */
    async hasCredentials(consoleId) {
      try {
        const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
        return Boolean(credentials[consoleId]);
      } catch {
        return false;
      }
    },

    wake(target, { passcode } = {}) {
      return power('wake', target, passcode);
    },

    standby(target, { passcode } = {}) {
      return power('standby', target, passcode);
    },

    /** The PSN sign-in URL of the Remote Play application. */
    async loginUrl() {
      const { OauthCredentialRequester } = loadPlayactorCredentials();
      const requester = new OauthCredentialRequester(playactorIo(''), {
        performLogin: async (url) => {
          throw new LoginUrlCaptured(url);
        },
      });
      try {
        await requester.performOauth();
      } catch (err) {
        if (err instanceof LoginUrlCaptured) return err.url;
        throw err;
      }
      throw new Error('playactor did not provide a sign-in URL');
    },

    /**
     * Pair a console: exchange the PSN redirect URL for an account id, then
     * register with the console using the PIN it displays. The console must
     * be awake. Existing credentials of the console are replaced.
     * @param {ReturnType<import('./protocol.js').parseSearchResponse>} info
     * @param {{ redirectUrl: string, pin: string }} pairing
     */
    async pair(info, { redirectUrl, pin }) {
      const {
        CredentialManager,
        DiskCredentialsStorage,
        OauthCredentialRequester,
        WriteOnlyStorage,
      } = loadPlayactorCredentials();
      const requester = new OauthCredentialRequester(playactorIo(pin), {
        performLogin: async () => redirectUrl,
      });
      const manager = new CredentialManager(
        requester,
        new WriteOnlyStorage(new DiskCredentialsStorage(credentialsPath)),
      );
      await manager.getForDevice(toPlayactorDevice(info));
      logger.info(`Console ${info.name} (${info.id}) paired`);
    },
  };
}
