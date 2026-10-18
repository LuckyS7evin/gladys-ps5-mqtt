# PS5 Remote Play for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls PlayStation 5 consoles (and optionally PlayStation 4) on the local
network: power on, rest mode, console status and the game being played.

It is a native port of the Home Assistant add-on
[ps5-mqtt](https://github.com/FunkeyFlo/ps5-mqtt): the same Remote Play
protocol (through [playactor](https://github.com/dhleong/playactor)) and the
same PlayStation Network presence lookup (through
[psn-api](https://github.com/achievements-app/psn-api)), with the Gladys
integration SDK in place of MQTT — no broker, a single container.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Features

| Feature                                   | How                                                               |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Discover the consoles on the LAN          | `SRCH` broadcast emitted by the Gladys core (`scanNetwork`) + IPs |
| Power on / rest mode                      | `playactor wake` / `playactor standby` (child process)            |
| Console state (on, rest mode, offline)    | unicast `SRCH` on every Gladys poll (10 s)                        |
| Game being played                         | PSN presence of the account (NPSSO), or the PS4 reply itself      |
| Pairing (PSN sign-in + PIN)               | two buttons of the Configuration screen                           |
| Scene triggers `game_started` / `stopped` | `publishSceneEvent`, with `title_name` / `title_id` variables     |
| Dashboard widget `now_playing`            | power tile, cover, status, game, power buttons                    |

Each console is a Gladys device keyed on its `host-id`, with three features:
`power` (switch, controllable), `status` (`playing` | `idle` | `standby` |
`offline`) and `game` (title name).

## How it works

```
index.js               SDK bootstrap + graceful shutdown
src/app.js             handlers wiring (scan, poll, set value, actions, widget, PSN loop)
src/consoles.js        ConsoleManager: device payloads, states, activity, scene events
src/protocol.js        discovery protocol: SRCH request, reply parsing
src/network.js         unicast SRCH query (dgram)
src/discovery.js       core broadcast scan + static IPs
src/playactor.js       wake / standby (CLI child process), pairing (in-process)
src/playactor-preload.cjs  keep-alive shim of ps5-mqtt #678, loaded in the playactor child
src/psn.js             NPSSO sign-in, persisted tokens, presence
src/actions.js         manifest actions: sign-in link, pairing, PSN test
src/widgets.js         now_playing widget + cover images
src/config.js          config defaults + normalization
```

The integration container runs on a bridge network: LAN broadcasts do not
reach it, unicast does. Discovery therefore asks the Gladys core to broadcast
the `SRCH` request (`network_discovery` / `udp-active-broadcast` on ports 9302
and 987); everything else (state, wake, standby, pairing) talks to the
console's IP directly.

A power command acks Gladys at once and runs in the background (a standby
handshake can take 20 seconds, Gladys waits 5): the confirmed state is
published when the console accepted it, and the previous one is re-sent if it
failed.

Persistent data, all under `/data` (the only writable volume):
`credentials.json` (playactor Remote Play credentials) and `psn-auth.json`
(PSN OAuth tokens, mode 0600). The NPSSO itself is never written.

## Development

```bash
npm install
npm test               # node --test
npm run lint           # ESLint
npm run format:check   # Prettier
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run it against a Gladys instance:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="<selector>" \
DATA_DIR=./data \
LOG_LEVEL=debug \
npm start
```

The tests run the whole integration against the fake Gladys of the SDK
(`@gladysassistant/integration-sdk/testing`), with the network parts replaced
by stand-ins: they never reach a console nor the PlayStation Network.

## Release

1. Describe the changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
2. **Actions → Release → Run workflow**, pick `major` for the first release
   (`1.0.0`), then `patch` / `minor`. The workflow bumps `package.json` and the
   manifest, tags, builds the `linux/amd64` + `linux/arm64` image to
   `ghcr.io/luckys7evin/gladys-ps5-mqtt` and publishes the GitHub Release.
3. Make the package public on ghcr.io (first release only), and add the
   `gladys-assistant-integration` topic to the repository: the store indexer
   picks the integration up.

Started from the official
[integration template](https://github.com/GladysAssistant/integration-template-js).

## Credits

- [ps5-mqtt](https://github.com/FunkeyFlo/ps5-mqtt) by FunkeyFlo and
  andrew-codes (MIT) — behavior, timeouts and workarounds this port follows.
- [playactor](https://github.com/dhleong/playactor) by dhleong (MIT) — the
  Remote Play protocol.
- [psn-api](https://github.com/achievements-app/psn-api) (MIT) — the
  PlayStation Network API.

PlayStation, PS4, PS5 and PS Remote Play are trademarks of Sony Interactive
Entertainment. This project is not affiliated with Sony.

## License

Apache-2.0
