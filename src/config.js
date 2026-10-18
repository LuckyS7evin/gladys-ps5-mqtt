// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  // Comma-separated console IPs, for consoles the broadcast scan cannot reach
  // (another VLAN, a router dropping broadcasts).
  static_ips: '',
  include_ps4: false,
  // Seconds between two PSN presence reads. The PSN API allows 300 requests
  // per 15 minutes: 10 s is the floor, 30 s leaves room for several accounts.
  psn_poll_interval: 30,
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Split the `static_ips` field into valid IPv4 addresses (invalid entries are
 * dropped: they could only fail later, one poll at a time).
 */
export function parseStaticIps(value) {
  return [
    ...new Set(
      String(value ?? '')
        .split(/[\s,;]+/)
        .map((ip) => ip.trim())
        .filter((ip) => IPV4.test(ip)),
    ),
  ];
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const interval = Number(raw.psn_poll_interval ?? DEFAULT_CONFIG.psn_poll_interval);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    static_ips: parseStaticIps(raw.static_ips),
    include_ps4: raw.include_ps4 === true || raw.include_ps4 === 'true',
    login_passcode: String(raw.login_passcode ?? '').trim(),
    npsso: String(raw.npsso ?? '').trim(),
    psn_preferred_console: raw.psn_preferred_console || null,
    psn_poll_interval: Number.isFinite(interval) ? Math.min(Math.max(interval, 10), 600) : 30,
  };
}
