# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- PS5 Remote Play integration, a native port of the Home Assistant add-on
  ps5-mqtt, built from the official Gladys integration template.
- Discovery of the PlayStation 5 consoles of the local network through the
  Gladys core, and of consoles typed by IP address.
- Optional PlayStation 4 support.
- One device per console: power (switch on, rest mode), status (playing, idle,
  standby, offline) and game being played, read every 10 seconds.
- Pairing from the Configuration screen: PlayStation sign-in link, then the PIN
  shown by the console.
- Game being played, from the PlayStation Network presence of the account
  (NPSSO token), with the tokens kept and refreshed by the integration.
- Profile passcode support.
- "Game started" and "Game stopped" scene triggers (Gladys 5.1.0 or later).
- "PlayStation" dashboard widget: power, status, game cover and power buttons.

[Unreleased]: https://github.com/LuckyS7evin/gladys-ps5-mqtt/commits/main
