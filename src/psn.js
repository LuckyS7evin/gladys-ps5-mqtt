// -----------------------------------------------------------------------------
// PlayStation Network account: what is being played.
//
// The consoles themselves only say "awake" or "rest mode". The game comes from
// the PSN presence of the user's account, read with psn-api from an NPSSO
// token (https://ca.account.sony.com/api/v1/ssocookie). The NPSSO only
// bootstraps the account: the OAuth tokens it yields are persisted in
// /data/psn-auth.json and refreshed, so the integration keeps working after
// the NPSSO itself expired (two months), as long as it runs regularly.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import * as psnApi from 'psn-api';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'psn' });

// Refresh the access token a minute before it expires.
const EXPIRY_MARGIN_MS = 60_000;

const hashNpsso = (npsso) => createHash('sha256').update(npsso).digest('hex');

function toAuthInfo(tokens, now) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiration: now + tokens.expiresIn * 1000,
    refreshTokenExpiration: now + tokens.refreshTokenExpiresIn * 1000,
  };
}

/**
 * Normalize a PSN basic presence into the activity of ONE title, or `null`
 * when the account is offline or plays nothing.
 */
export function parsePresence(response) {
  const presence = response?.basicPresence;
  const online =
    presence?.primaryPlatformInfo?.onlineStatus === 'online' || presence?.onlineStatus === 'online';
  const title = presence?.gameTitleInfoList?.[0];
  if (!online || !title) {
    return null;
  }
  return {
    titleId: title.npTitleId,
    titleName: title.titleName,
    titleImage: title.npTitleIconUrl ?? title.conceptIconUrl ?? null,
    // The console the title runs on: a PS4 game launched on a PS5 is a PS5 activity.
    platform: String(title.launchPlatform ?? title.format ?? '').toUpperCase(),
  };
}

/**
 * @param {{ dataDir: string, api?: typeof psnApi, now?: () => number }} options
 */
export function createPsnClient({ dataDir, api = psnApi, now = Date.now }) {
  const storePath = `${dataDir}/psn-auth.json`;
  let account = null;
  let npsso = null;

  async function readStore() {
    try {
      return JSON.parse(await readFile(storePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async function persist() {
    await writeFile(storePath, JSON.stringify({ npssoHash: hashNpsso(npsso), ...account }), {
      mode: 0o600,
    });
    // writeFile only applies the mode to a new file.
    await chmod(storePath, 0o600);
  }

  async function authFromNpsso() {
    const code = await api.exchangeNpssoForCode(npsso);
    return toAuthInfo(await api.exchangeCodeForAccessToken(code), now());
  }

  async function freshAuth() {
    const { authInfo } = account;
    if (now() < authInfo.accessTokenExpiration - EXPIRY_MARGIN_MS) {
      return authInfo;
    }
    if (now() < authInfo.refreshTokenExpiration - EXPIRY_MARGIN_MS) {
      account.authInfo = toAuthInfo(
        await api.exchangeRefreshTokenForAuthTokens(authInfo.refreshToken),
        now(),
      );
    } else {
      account.authInfo = await authFromNpsso();
    }
    await persist();
    return account.authInfo;
  }

  return {
    get account() {
      return account && { accountId: account.accountId, accountName: account.accountName };
    },

    /**
     * Sign in with the NPSSO, reusing the persisted tokens when they belong to
     * the same NPSSO and can still be refreshed.
     * @returns {Promise<{ accountId: string, accountName: string }>}
     */
    async connect(newNpsso) {
      npsso = newNpsso;
      account = null;
      const stored = await readStore();
      if (stored?.npssoHash === hashNpsso(npsso) && stored.accountId && stored.authInfo) {
        account = {
          accountId: stored.accountId,
          accountName: stored.accountName,
          authInfo: stored.authInfo,
        };
        try {
          await freshAuth();
          return this.account;
        } catch (err) {
          logger.warn(`Persisted PSN tokens unusable, signing in again: ${err.message}`);
          account = null;
        }
      }
      const authInfo = await authFromNpsso();
      const { profile } = await api.getProfileFromUserName(authInfo, 'me');
      account = { accountId: profile.accountId, accountName: profile.onlineId, authInfo };
      await persist();
      logger.info(`Signed in to PSN as ${account.accountName}`);
      return this.account;
    },

    disconnect() {
      account = null;
      npsso = null;
    },

    /** The title being played on the account, or `null`. */
    async getActivity() {
      if (!account) {
        throw new Error('PSN account not connected');
      }
      const authInfo = await freshAuth();
      return parsePresence(await api.getBasicPresence(authInfo, account.accountId));
    },
  };
}
