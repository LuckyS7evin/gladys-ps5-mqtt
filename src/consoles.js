// -----------------------------------------------------------------------------
// The consoles, as Gladys devices.
//
// One device per console, keyed on the `host-id` the console reports (stable
// across IP changes and firmware updates). Three features:
//   - power  : switch/binary  — 1 wakes the console up, 0 puts it in rest mode
//   - status : text           — playing | idle | standby | offline
//   - game   : text           — title being played (PSN account, or PS4 reply)
//
// The power state is read with a unicast `SRCH` on every Gladys poll; the game
// is pushed by the PSN loop (index.js) through `updateActivity`.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { discoverConsoles } from './discovery.js';
import { queryConsole } from './network.js';
import { CONSOLE_TYPES, POWER_STATUS } from './protocol.js';

const logger = createLogger({ name: 'consoles' });

export const DEVICE_TYPE = 'console';

export const FEATURES = { POWER: 'power', STATUS: 'status', GAME: 'game' };

export const PARAMS = {
  HOST_ID: 'HOST_ID',
  IP_ADDRESS: 'IP_ADDRESS',
  HOST_TYPE: 'HOST_TYPE',
  SYSTEM_VERSION: 'SYSTEM_VERSION',
};

export const ACTIVITY_STATUS = {
  PLAYING: 'playing',
  IDLE: 'idle',
  STANDBY: 'standby',
  OFFLINE: 'offline',
};

// Scene trigger keys, as declared in the manifest `scene_triggers` field.
export const SCENE_TRIGGERS = { GAME_STARTED: 'game_started', GAME_STOPPED: 'game_stopped' };

// Text published in the game feature when nothing is played (Gladys refuses
// an empty text state).
export const NO_GAME = '-';

// A console keeps answering its previous state for a few seconds after a
// wake or standby request: the polls do not overwrite the requested power
// state during that window.
const TRANSITION_MS = 30_000;

// An unreachable console may have changed IP: rescan, at most this often.
const REDISCOVERY_COOLDOWN_MS = 5 * 60_000;

// Re-send unchanged states every 30 minutes, so they stay recently dated.
const HEARTBEAT_MS = 30 * 60_000;

const param = (device, name) => device.params?.find((p) => p.name === name)?.value;

/**
 * Discovery payload of one console.
 */
export function buildDevice(gladys, info) {
  const ids = gladys.externalIds(DEVICE_TYPE, info.id);
  const model = info.type === CONSOLE_TYPES.PS4 ? 'PlayStation 4' : 'PlayStation 5';
  return {
    name: info.name,
    external_id: ids.device,
    model,
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_10_SECONDS,
    params: [
      { name: PARAMS.HOST_ID, value: info.id },
      { name: PARAMS.IP_ADDRESS, value: info.address },
      { name: PARAMS.HOST_TYPE, value: info.type },
      { name: PARAMS.SYSTEM_VERSION, value: info.systemVersion ?? '' },
    ],
    features: [
      {
        name: 'Power',
        external_id: ids.feature(FEATURES.POWER),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        read_only: false,
        has_feedback: true,
        keep_history: true,
        min: 0,
        max: 1,
      },
      {
        name: 'Status',
        external_id: ids.feature(FEATURES.STATUS),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: false,
        // Gladys stores min/max as NOT NULL for every feature, text included
        // (422 on device creation otherwise); they bound nothing for a text.
        min: 0,
        max: 0,
      },
      {
        name: 'Game',
        external_id: ids.feature(FEATURES.GAME),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: false,
        // Gladys stores min/max as NOT NULL for every feature, text included
        // (422 on device creation otherwise); they bound nothing for a text.
        min: 0,
        max: 0,
      },
    ],
  };
}

/**
 * The status shown in the `status` feature, from what we know of a console.
 */
export function activityStatus(state) {
  if (!state.available) return ACTIVITY_STATUS.OFFLINE;
  if (state.power === POWER_STATUS.STANDBY) return ACTIVITY_STATUS.STANDBY;
  return state.activity ? ACTIVITY_STATUS.PLAYING : ACTIVITY_STATUS.IDLE;
}

/**
 * Owns the runtime knowledge of the consoles (addresses, power states,
 * activities) and turns it into Gladys states and scene events.
 */
export class ConsoleManager {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {ReturnType<import('./playactor.js').createPlayactorClient>} options.playactor
   * @param {() => ReturnType<import('./config.js').normalizeConfig>} options.getConfig
   * @param {typeof queryConsole} [options.query]
   * @param {typeof discoverConsoles} [options.discover]
   * @param {() => void} [options.onChange] - what a widget shows changed
   * @param {() => number} [options.now]
   */
  constructor({
    gladys,
    playactor,
    getConfig,
    query = queryConsole,
    discover = discoverConsoles,
    onChange = () => {},
    now = Date.now,
  }) {
    this.gladys = gladys;
    this.playactor = playactor;
    this.getConfig = getConfig;
    this.query = query;
    this.discover = discover;
    this.onChange = onChange;
    this.now = now;
    // host-id -> last discovery reply (address, type, name...)
    this.known = new Map();
    // host-id -> { power, available, activity, transition }
    this.states = new Map();
    // host-id -> "status|game" last published, to nudge the widgets on a change
    this.shown = new Map();
    // host-id -> running power command
    this.pending = new Map();
    this.lastRediscovery = 0;
    this.rediscovery = null;
  }

  ids(consoleId) {
    return this.gladys.externalIds(DEVICE_TYPE, consoleId);
  }

  /** host-id of a Gladys device of this integration, or null. */
  consoleIdOf(device) {
    const fromParam = param(device, PARAMS.HOST_ID);
    if (fromParam) return fromParam;
    const prefix = this.gladys.externalId(`${DEVICE_TYPE}:`);
    return device.external_id?.startsWith(prefix) ? device.external_id.slice(prefix.length) : null;
  }

  /** Where to reach a console: the last discovery wins over the device params. */
  targetOf(device) {
    const id = this.consoleIdOf(device);
    if (!id) return null;
    const known = this.known.get(id);
    return {
      id,
      name: known?.name ?? device.name,
      address: known?.address ?? param(device, PARAMS.IP_ADDRESS),
      type: known?.type ?? param(device, PARAMS.HOST_TYPE) ?? CONSOLE_TYPES.PS5,
    };
  }

  stateOf(consoleId) {
    if (!this.states.has(consoleId)) {
      this.states.set(consoleId, {
        power: null,
        available: false,
        activity: null,
        transition: null,
      });
    }
    return this.states.get(consoleId);
  }

  /** The created Gladys devices of this integration that are consoles. */
  createdConsoles() {
    return (this.gladys.devices ?? []).filter((device) => this.consoleIdOf(device));
  }

  remember(info) {
    this.known.set(info.id, info);
    const state = this.stateOf(info.id);
    if (!this.inTransition(state)) state.power = info.status;
    state.available = true;
  }

  inTransition(state) {
    return state.transition !== null && this.now() < state.transition.until;
  }

  /**
   * Scan the network and publish every console found.
   * @returns {Promise<Array<object>>} the discovery replies
   */
  async scan() {
    const consoles = await this.discover(this.gladys, this.getConfig());
    for (const info of consoles) this.remember(info);
    await this.gladys.publishDiscoveredDevices(
      consoles.map((info) => buildDevice(this.gladys, info)),
    );
    return consoles;
  }

  // Background rescan after a console stopped answering at its address.
  maybeRediscover() {
    if (this.rediscovery || this.now() - this.lastRediscovery < REDISCOVERY_COOLDOWN_MS) return;
    this.lastRediscovery = this.now();
    this.rediscovery = this.scan()
      .catch((err) => logger.warn(`Rediscovery failed: ${err.message}`))
      .finally(() => {
        this.rediscovery = null;
      });
  }

  /**
   * Read the power state of a console (Gladys poll) and publish it.
   */
  async poll(device) {
    const target = this.targetOf(device);
    if (!target?.address) return;
    const info = await this.query(target.address, { type: target.type });
    const state = this.stateOf(target.id);
    if (info && info.id === target.id) {
      this.remember(info);
      // A PS4 names its running application itself: no PSN account needed.
      if (info.type === CONSOLE_TYPES.PS4 && !this.getConfig().npsso) {
        await this.setActivity(
          target.id,
          info.runningAppTitleId
            ? { titleId: info.runningAppTitleId, titleName: info.runningAppName, titleImage: null }
            : null,
        );
      }
    } else {
      if (state.available) logger.info(`${target.name} does not answer at ${target.address}`);
      state.available = false;
    }
    if (!state.available || state.power === POWER_STATUS.STANDBY) {
      await this.setActivity(target.id, null);
    }
    await this.publish(target.id);
    // After publishing: a console found at a new address is read by the next poll.
    if (!state.available) this.maybeRediscover();
  }

  /**
   * Wake a console up (value 1) or put it in rest mode (value 0).
   *
   * Gladys awaits a command ack for 5 seconds, and a standby handshake can
   * take 20: the request is checked here (address, pairing, nothing already
   * running), then runs in the background. `completion` settles when the
   * console confirmed — the new state is published then (has_feedback) — or
   * when it failed, the previous state being re-sent to undo the switch.
   * @returns {Promise<{ completion: Promise<void> }>}
   */
  async setPower(device, value) {
    const target = this.targetOf(device);
    if (!target?.address) {
      throw new Error(`No address known for ${device.external_id}`);
    }
    if (!(await this.playactor.hasCredentials(target.id))) {
      throw new Error(
        `${target.name} is not paired yet: run the "Pair a console" action of the integration.`,
      );
    }
    if (this.pending.has(target.id)) {
      throw new Error(`A power command is already running on ${target.name}`);
    }
    const completion = this.runPower(target, value === 1).finally(() => {
      this.pending.delete(target.id);
    });
    this.pending.set(target.id, completion);
    return { completion };
  }

  async runPower(target, awake) {
    const { login_passcode: passcode } = this.getConfig();
    const state = this.stateOf(target.id);
    try {
      if (awake) {
        await this.playactor.wake(target, { passcode });
      } else {
        await this.playactor.standby(target, { passcode });
      }
    } catch (err) {
      logger.error(`${awake ? 'Wake' : 'Standby'} of ${target.name} failed: ${err.message}`);
      // The switch moved in the UI: re-send the state we know to put it back.
      this.gladys.forgetPublishedStates(this.ids(target.id).device);
      await this.publish(target.id);
      throw err;
    }
    state.power = awake ? POWER_STATUS.AWAKE : POWER_STATUS.STANDBY;
    state.available = true;
    state.transition = { until: this.now() + TRANSITION_MS };
    if (!awake) await this.setActivity(target.id, null);
    await this.publish(target.id);
  }

  /**
   * The PSN loop reports what the account plays: attach it to the console it
   * most likely runs on (best effort, like ps5-mqtt): the preferred console
   * of the configuration if it is awake and of the right type, else the first
   * awake console of that type. Every other console plays nothing.
   */
  async updateActivity(activity) {
    const consoles = this.createdConsoles().map((device) => this.targetOf(device));
    let owner = null;
    if (activity) {
      const candidates = consoles.filter((target) => {
        const state = this.stateOf(target.id);
        return (
          state.available &&
          state.power === POWER_STATUS.AWAKE &&
          (!activity.platform || target.type === activity.platform)
        );
      });
      const preferred = this.getConfig().psn_preferred_console;
      owner =
        candidates.find((target) => this.ids(target.id).device === preferred) ?? candidates[0];
      if (!owner) logger.debug(`No awake console for ${activity.titleName}`);
    }
    for (const target of consoles) {
      // A console not polled yet is left to its first poll: publishing now
      // would show it offline for a few seconds after every start.
      if (this.stateOf(target.id).power === null) continue;
      await this.setActivity(target.id, target === owner ? activity : null);
      await this.publish(target.id);
    }
  }

  // Change the activity of a console; fires the scene triggers on a change
  // of title (one event per transition).
  async setActivity(consoleId, activity) {
    const state = this.stateOf(consoleId);
    const previous = state.activity;
    if ((previous?.titleId ?? null) === (activity?.titleId ?? null)) {
      state.activity = activity ?? null;
      return;
    }
    state.activity = activity ?? null;
    const device = this.ids(consoleId).device;
    if (previous) {
      await this.fire(SCENE_TRIGGERS.GAME_STOPPED, device, previous);
    }
    if (activity) {
      await this.fire(SCENE_TRIGGERS.GAME_STARTED, device, activity);
    }
  }

  async fire(trigger, device, activity) {
    try {
      await this.gladys.publishSceneEvent(trigger, {
        device,
        title_name: activity.titleName ?? null,
        title_id: activity.titleId ?? null,
      });
    } catch (err) {
      // An older core without scene triggers, a rate limit: the states still go out.
      logger.warn(`Scene event ${trigger} refused: ${err.message}`);
    }
  }

  /** Publish the three features of a console (only what changed). */
  async publish(consoleId) {
    const ids = this.ids(consoleId);
    const state = this.stateOf(consoleId);
    const on = state.available && state.power === POWER_STATUS.AWAKE;
    const status = activityStatus(state);
    const game = state.activity?.titleName || NO_GAME;
    await this.gladys.publishChangedStates(
      [
        { device_feature_external_id: ids.feature(FEATURES.POWER), state: on ? 1 : 0 },
        { device_feature_external_id: ids.feature(FEATURES.STATUS), text: status },
        { device_feature_external_id: ids.feature(FEATURES.GAME), text: game },
      ],
      { heartbeat: HEARTBEAT_MS },
    );
    const shown = `${status}|${game}`;
    if (this.shown.get(consoleId) !== shown) {
      this.shown.set(consoleId, shown);
      this.onChange();
    }
  }

  /** What the widget shows about a console. */
  snapshot(externalId) {
    const device = this.createdConsoles().find((d) => d.external_id === externalId);
    if (!device) return null;
    const target = this.targetOf(device);
    const state = this.stateOf(target.id);
    return {
      ...target,
      externalId,
      status: activityStatus(state),
      activity: state.activity,
      powerFeature: this.ids(target.id).feature(FEATURES.POWER),
    };
  }

  /** Find the activity whose cover a widget image key names. */
  activityByImageKey(imageKey) {
    for (const state of this.states.values()) {
      if (state.activity && coverImageKey(state.activity) === imageKey) return state.activity;
    }
    return null;
  }
}

/**
 * Widget image key of a title cover: stable per title, so the core's one-hour
 * cache by key stays right.
 */
export function coverImageKey(activity) {
  const slug = String(activity.titleId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `cover-${slug}`.slice(0, 64);
}
