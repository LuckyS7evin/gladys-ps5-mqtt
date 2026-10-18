// -----------------------------------------------------------------------------
// Dashboard widgets (SDK v0.14+, Gladys 5.1+).
//
// `now_playing`: one console per widget instance (a `"source": "devices"`
// setting). A live power tile, the cover of the game being played, the status
// and the game as computed rows, and two buttons bound to the power feature —
// they go through `onSetValue` like the device card, nothing else to handle.
//
// The cover is served by the integration (`onWidgetGetImage`): the browser
// never loads a third-party URL. Its key is stable per title, the core caches
// an image one hour by key.
// -----------------------------------------------------------------------------

import { createLogger, validateWidgetImage, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { ACTIVITY_STATUS, coverImageKey } from './consoles.js';

const logger = createLogger({ name: 'widgets' });

// Widget key, as declared in the manifest `widgets` field.
export const NOW_PLAYING_WIDGET = 'now_playing';

const STATUS_DISPLAY = {
  [ACTIVITY_STATUS.PLAYING]: {
    value: { en: 'Playing', fr: 'En jeu' },
    color: WIDGET_COLORS.SUCCESS,
  },
  [ACTIVITY_STATUS.IDLE]: { value: { en: 'On', fr: 'Allumée' }, color: WIDGET_COLORS.INFO },
  [ACTIVITY_STATUS.STANDBY]: {
    value: { en: 'Rest mode', fr: 'Mode repos' },
    color: WIDGET_COLORS.NEUTRAL,
  },
  [ACTIVITY_STATUS.OFFLINE]: {
    value: { en: 'Unreachable', fr: 'Injoignable' },
    color: WIDGET_COLORS.DANGER,
  },
};

// The core truncates longer status values; cut on our side to end with "…".
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Width asked to the PlayStation image service: a 16:9 frame renders under
// 800 px, and the core refuses images over 300 KB.
const COVER_WIDTH = 480;

export function coverUrl(titleImage) {
  const url = new URL(titleImage);
  if (url.hostname === 'image.api.playstation.com') {
    url.searchParams.set('w', String(COVER_WIDTH));
  }
  return url.toString();
}

/**
 * Content of the `now_playing` widget for one console snapshot (see
 * ConsoleManager.snapshot), or the empty state when none is chosen.
 */
export function buildNowPlayingContent(snapshot) {
  if (!snapshot) {
    return {
      ttl_seconds: 300,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: {
            en: 'Choose a console in the widget settings.',
            fr: 'Choisissez une console dans les réglages du widget.',
          },
        },
      ],
    };
  }
  const { activity } = snapshot;
  const components = [
    { type: 'text', variant: 'heading', text: truncate(snapshot.name, 40) },
    {
      type: 'value',
      label: { en: 'Power', fr: 'Alimentation' },
      icon: 'power',
      device_feature: snapshot.powerFeature,
    },
  ];
  if (activity?.titleImage) {
    components.push({
      type: 'image',
      key: coverImageKey(activity),
      alt: truncate(activity.titleName ?? '', 100),
      fit: 'contain',
    });
  }
  components.push(
    {
      type: 'status',
      items: [
        {
          label: { en: 'Status', fr: 'État' },
          icon: 'monitor',
          ...STATUS_DISPLAY[snapshot.status],
        },
        {
          label: { en: 'Game', fr: 'Jeu' },
          icon: 'play',
          value: truncate(activity?.titleName || '-', 40),
          color: activity ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
        },
      ],
    },
    {
      type: 'button',
      label: { en: 'Switch on', fr: 'Allumer' },
      icon: 'power',
      style: 'primary',
      device_feature: snapshot.powerFeature,
      value: 1,
    },
    {
      type: 'button',
      label: { en: 'Rest mode', fr: 'Mode repos' },
      icon: 'moon',
      style: 'secondary',
      device_feature: snapshot.powerFeature,
      value: 0,
    },
  );
  // The power tile follows the states live; the computed rows change with
  // the status, and index.js nudges the widget then: the TTL is a safety net.
  return { ttl_seconds: 60, components };
}

/**
 * @param {{ consoles: import('./consoles.js').ConsoleManager, fetchImpl?: typeof fetch }} deps
 */
export function createWidgets({ consoles, fetchImpl = (...args) => fetch(...args) }) {
  return {
    widgets: {
      [NOW_PLAYING_WIDGET]: {
        async get({ settings }) {
          logger.debug(`onWidgetGet <- ${NOW_PLAYING_WIDGET}`);
          return buildNowPlayingContent(
            settings?.console ? consoles.snapshot(settings.console) : null,
          );
        },
      },
    },

    // Resolve the RAW base64 of a cover (no data-URI prefix).
    async getImage(imageKey) {
      const activity = consoles.activityByImageKey(imageKey);
      if (!activity?.titleImage) {
        throw new Error(`Unknown image ${imageKey}`);
      }
      const response = await fetchImpl(coverUrl(activity.titleImage));
      if (!response.ok) {
        throw new Error(`Cover download failed (${response.status})`);
      }
      const image = Buffer.from(await response.arrayBuffer()).toString('base64');
      const issues = validateWidgetImage(image);
      if (issues.length > 0) {
        throw new Error(`Cover refused: ${issues.join('; ')}`);
      }
      return image;
    },
  };
}

/**
 * Freshness nudge: ask the core to re-pull every widget NOW instead of
 * waiting for the content TTL (rate-limited core-side to 1 per 10 s per
 * widget, dropped silently while disconnected).
 */
export function refreshWidgets(gladys) {
  gladys.requestWidgetRefresh(NOW_PLAYING_WIDGET);
}
