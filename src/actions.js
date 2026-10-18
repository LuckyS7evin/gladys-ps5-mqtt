// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Pairing replaces the web UI of ps5-mqtt with two buttons:
//   1. `psn_login_link` shows the PlayStation sign-in link of the Remote Play
//      application; after signing in, the browser lands on a blank page whose
//      address holds a one-time code;
//   2. `pair_console` takes that address and the PIN the console displays
//      (Settings > System > Remote Play > Link Device) and registers with the
//      console. The credentials land in /data/credentials.json.
// `test_psn` checks the NPSSO of the configuration and tells what is played.
//
// Each handler resolves the multi-language message shown under the button.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { POWER_STATUS } from './protocol.js';

const logger = createLogger({ name: 'actions' });

export const ACTION_KEYS = {
  PSN_LOGIN_LINK: 'psn_login_link',
  PAIR_CONSOLE: 'pair_console',
  TEST_PSN: 'test_psn',
};

/**
 * Check the address the browser landed on after the PlayStation sign-in.
 * Returns the trimmed URL, or null when it carries no code.
 */
export function parseRedirectUrl(value) {
  const text = String(value ?? '').trim();
  try {
    const url = new URL(text);
    return url.searchParams.get('code') ? text : null;
  } catch {
    return null;
  }
}

/** The 8-digit PIN shown by the console, spaces allowed. Null when invalid. */
export function parsePin(value) {
  const digits = String(value ?? '').replace(/\s+/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

/**
 * @param {object} deps
 * @param {import('./consoles.js').ConsoleManager} deps.consoles
 * @param {ReturnType<import('./playactor.js').createPlayactorClient>} deps.playactor
 * @param {ReturnType<import('./psn.js').createPsnClient>} deps.psn
 * @param {() => ReturnType<import('./config.js').normalizeConfig>} deps.getConfig
 */
export function createActions({ consoles, playactor, psn, getConfig }) {
  return {
    async [ACTION_KEYS.PSN_LOGIN_LINK]() {
      const url = await playactor.loginUrl();
      return {
        en: `Open this link, sign in, then copy the address of the blank page you land on: ${url}`,
        fr: `Ouvrez ce lien, connectez-vous, puis copiez l'adresse de la page blanche affichée : ${url}`,
      };
    },

    async [ACTION_KEYS.PAIR_CONSOLE](fields) {
      const redirectUrl = parseRedirectUrl(fields.redirect_url);
      if (!redirectUrl) {
        return {
          en: 'The address must be the one of the blank page shown after signing in (it contains "code=").',
          fr: "L'adresse doit être celle de la page blanche affichée après la connexion (elle contient « code= »).",
        };
      }
      const pin = parsePin(fields.pin);
      if (!pin) {
        return {
          en: 'The PIN is the 8-digit code shown in Settings > System > Remote Play > Link Device.',
          fr: 'Le code PIN est le code à 8 chiffres affiché dans Paramètres > Système > Lecture à distance > Associer un appareil.',
        };
      }
      const device = consoles.createdConsoles().find((d) => d.external_id === fields.device);
      const target = device && consoles.targetOf(device);
      if (!target?.address) {
        return {
          en: 'Unknown console: add it from the Discovery tab first.',
          fr: "Console inconnue : ajoutez-la d'abord depuis l'onglet Découverte.",
        };
      }
      const info = await consoles.query(target.address, { type: target.type });
      if (!info || info.status !== POWER_STATUS.AWAKE) {
        return {
          en: `${target.name} must be switched on (not in rest mode) to be paired.`,
          fr: `${target.name} doit être allumée (pas en mode repos) pour être associée.`,
        };
      }
      try {
        await playactor.pair(info, { redirectUrl, pin });
      } catch (err) {
        logger.error(`Pairing of ${target.name} failed`, err);
        throw new Error(
          `Pairing failed (${err.message}). Ask for a new sign-in link and a new PIN, then try again.`,
          { cause: err },
        );
      }
      consoles.remember(info);
      await consoles.publish(info.id);
      return {
        en: `${target.name} is paired: it can now be switched on and put in rest mode from Gladys.`,
        fr: `${target.name} est associée : elle peut maintenant être allumée et mise en veille depuis Gladys.`,
      };
    },

    async [ACTION_KEYS.TEST_PSN]() {
      const { npsso } = getConfig();
      if (!npsso) {
        return {
          en: 'No NPSSO token in the configuration: the game played is not tracked.',
          fr: "Aucun jeton NPSSO dans la configuration : le jeu en cours n'est pas suivi.",
        };
      }
      const account = psn.account ?? (await psn.connect(npsso));
      const activity = await psn.getActivity();
      await consoles.updateActivity(activity);
      if (!activity) {
        return {
          en: `Signed in as ${account.accountName}: nothing is being played right now.`,
          fr: `Connecté en tant que ${account.accountName} : aucun jeu en cours.`,
        };
      }
      return {
        en: `Signed in as ${account.accountName}: playing ${activity.titleName} (${activity.platform}).`,
        fr: `Connecté en tant que ${account.accountName} : joue à ${activity.titleName} (${activity.platform}).`,
      };
    },
  };
}
