// -----------------------------------------------------------------------------
// Wiring of the SDK handlers to the PS5 modules.
//
// Kept out of index.js so the tests can run the whole integration against
// the fake Gladys of the SDK, with the network parts (unicast query, scan,
// playactor, PSN) replaced by stand-ins.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createActions } from './actions.js';
import { normalizeConfig } from './config.js';
import { ConsoleManager, FEATURES } from './consoles.js';
import { createPlayactorClient } from './playactor.js';
import { createPsnClient } from './psn.js';
import { createWidgets, refreshWidgets } from './widgets.js';

const logger = createLogger({ name: 'app' });

const PSN_FAILURE_MESSAGE = {
  en: 'PlayStation Network sign-in failed: generate a new NPSSO token (see the documentation).',
  fr: 'Connexion au PlayStation Network impossible : générez un nouveau jeton NPSSO (voir la documentation).',
};

/**
 * Register every handler on the SDK client, before `connect()`.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [deps] - stand-ins for the tests
 */
export function registerHandlers(gladys, deps = {}) {
  const dataDir = deps.dataDir ?? process.env.DATA_DIR ?? '/data';
  let config = normalizeConfig();
  const getConfig = () => config;

  const playactor = deps.playactor ?? createPlayactorClient({ dataDir });
  const psn = deps.psn ?? createPsnClient({ dataDir });
  const consoles = new ConsoleManager({
    gladys,
    playactor,
    getConfig,
    query: deps.query,
    discover: deps.discover,
    onChange: () => refreshWidgets(gladys),
  });
  const actions = createActions({ consoles, playactor, psn, getConfig });
  const { widgets, getImage } = createWidgets({ consoles, fetchImpl: deps.fetchImpl });

  // --- PSN presence loop -----------------------------------------------------
  let psnTimer = null;
  let psnBusy = false;
  let psnFailing = false;

  async function pollPsn() {
    if (psnBusy) return;
    psnBusy = true;
    try {
      await consoles.updateActivity(await psn.getActivity());
      if (psnFailing) logger.info('PSN presence readable again');
      psnFailing = false;
    } catch (err) {
      // Logged once per failure streak: the loop retries at its own pace.
      if (!psnFailing) logger.warn(`PSN presence read failed: ${err.message}`);
      psnFailing = true;
    } finally {
      psnBusy = false;
    }
  }

  function stopPsn() {
    clearInterval(psnTimer);
    psnTimer = null;
  }

  // (Re)start the loop from the current config. Resolves false when the
  // configured NPSSO cannot sign in.
  async function startPsn() {
    stopPsn();
    if (!config.npsso) {
      psn.disconnect();
      return true;
    }
    try {
      await psn.connect(config.npsso);
    } catch (err) {
      logger.error(`PSN sign-in failed: ${err.message}`);
      return false;
    }
    psnTimer = setInterval(pollPsn, config.psn_poll_interval * 1000);
    psnTimer.unref?.();
    await pollPsn();
    return true;
  }

  async function applyConfig(rawConfig) {
    config = normalizeConfig(rawConfig);
    const psnOk = await startPsn();
    await (psnOk
      ? gladys.setConnectionStatus(true)
      : gladys.setConnectionStatus(false, PSN_FAILURE_MESSAGE));
    // Status rows follow the PSN activity and the consoles: re-sync open
    // dashboards (nudges sent while disconnected were dropped).
    refreshWidgets(gladys);
  }

  // --- Discovery: Gladys asks for the list of consoles -----------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> scanning for consoles');
    await consoles.scan();
  });

  // --- Command: power switch -------------------------------------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    if (!feature.external_id.endsWith(`:${FEATURES.POWER}`)) {
      throw new Error(`${feature.external_id} is read-only`);
    }
    const { completion } = await consoles.setPower(device, Number(value));
    // Already logged and reverted by the manager.
    completion.catch(() => {});
  });

  // --- Polling: Gladys asks for the state of a console -----------------------
  gladys.onPoll((device) => consoles.poll(device));

  // --- Manifest actions --------------------------------------------------------
  for (const [key, handler] of Object.entries(actions)) {
    gladys.onAction(key, (fields) => handler(fields));
  }

  // --- Dashboard widgets -------------------------------------------------------
  for (const [key, widget] of Object.entries(widgets)) {
    gladys.onWidgetGet(key, (request) => widget.get(request));
  }
  gladys.onWidgetGetImage((imageKey) => getImage(imageKey));

  // --- Configuration and connection lifecycle ---------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    await applyConfig(newConfig);
  });

  gladys.on('connected', async () => {
    try {
      await applyConfig(await gladys.getConfig());
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    }
  });

  gladys.on('disconnected', stopPsn);

  return { consoles, getConfig, pollPsn, stopPsn };
}
