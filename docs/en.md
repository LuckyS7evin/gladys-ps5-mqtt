# PS5 Remote Play

Control your PlayStation 5 from Gladys: power on, rest mode, console status
and game being played, with scene triggers and a dashboard widget. The
integration follows the Home Assistant add-on
[ps5-mqtt](https://github.com/FunkeyFlo/ps5-mqtt), without MQTT: it talks to
the console directly with Sony's Remote Play protocol (through
[playactor](https://github.com/dhleong/playactor)).

PlayStation 4 consoles are supported too (power on, rest mode, running game)
once the dedicated option is enabled.

## Prepare the console

In the PS5 settings:

1. **System > Remote Play**: turn on **Enable Remote Play**.
2. **System > Power Saving > Features Available in Rest Mode**: turn on
   **Stay Connected to the Internet** and **Enable Turning On PS5 from
   Network**.
3. The console must be on the same local network as Gladys (or reachable from
   Gladys, see _Console IP addresses_).

Without these settings, the console does not answer in rest mode or refuses
the commands (403 error in the logs).

## Add the console

1. Switch the console on (not in rest mode).
2. Open the **Discovery** tab of the integration: Gladys searches the local
   network for consoles. Add yours.
3. If it does not show up (another VLAN, a router filtering broadcasts), type
   its IP address in **Console IP addresses** (several addresses separated by
   commas), save and run the discovery again.

Each console becomes a device with three features:

| Feature | Values                                              |
| ------- | --------------------------------------------------- |
| Power   | 1 = on, 0 = rest mode or unreachable (controllable) |
| Status  | `playing`, `idle`, `standby` or `offline`           |
| Game    | name of the game being played, `-` otherwise        |

The state is read every 10 seconds.

## Pair the console

To switch the console on or put it in rest mode, the integration must be
paired with the console, like the PS Remote Play app. It is done once, with
the two actions of the **Configuration** tab:

1. Click **1. Get the PlayStation sign-in link**. Open the link shown, sign in
   with the PlayStation account used on the console. You land on a blank page
   (or an error page): **copy its full address** from the address bar of the
   browser. It starts with
   `https://remoteplay.dl.playstation.net/remoteplay/redirect?code=`.
2. On the console, switched on, open **Settings > System > Remote Play > Link
   Device**: an 8-digit code shows up.
3. Click **2. Pair a console**, pick the console, paste the copied address and
   type the PIN. The message under the button confirms the pairing.

The copied address is only valid for a few minutes: if pairing fails, start
again from step 1 with a new PIN.

If your PlayStation profile asks for a passcode at login, set it in **Profile
passcode** (digits, or key names separated by spaces, e.g. `up up down down`).

## Game being played (optional)

The PS5 does not say what it runs. The game is read from the presence of your
PlayStation Network account, with an **NPSSO** token:

1. Sign in on [playstation.com](https://www.playstation.com/).
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>.
   The page shows `{"npsso":"…"}`: copy the 64-character value.
3. Paste it in **NPSSO token** and save.
4. Click **Test the PlayStation Network account** to check it.

The NPSSO token expires after two months, but it is only used for the first
sign-in: the integration then keeps and refreshes its own tokens (in its
`/data` volume, readable by it only). If signing in fails, the Configuration
screen says so: generate a new NPSSO token.

The game is attached to the switched-on console matching the platform of the
game. When several consoles are on, pick the **Preferred console**. The
**Game refresh interval** (30 s by default, 10 s minimum) stays within the
limit of Sony's API (300 requests per 15 minutes).

On a PS4, the running game comes from the console itself, no PSN account
needed.

## Scenes

- Use the **Power** feature of the console in the "Control a device" actions
  to switch the console on or put it in rest mode, and in the "Device state
  change" triggers to react when it is switched on.
- **Game started** (trigger): a game starts on a console. Optionally filter on
  the console and the title ID (e.g. `PPSA01521_00`). The following actions
  can read `{{triggerEvent.data.title_name}}` and
  `{{triggerEvent.data.title_id}}`.
- **Game stopped** (trigger): the game is closed, the console is put in rest
  mode or is no longer reachable.

Example: "when a game starts on the living room PS5, dim the lights and turn
the soundbar on".

## Dashboard

Add the **PlayStation** widget and pick a console: it shows the live power
state, the status, the game being played with its cover, and two buttons,
**Switch on** and **Rest mode**.

## Troubleshooting

- **The console is not in the Discovery tab**: check it is on or in rest mode
  with **Stay Connected to the Internet**, then type its IP address in the
  configuration.
- **"not paired yet"**: pair the console (actions 1 and 2).
- **403 error**: Remote Play is disabled on the console, or the pairing was
  removed: pair the console again.
- **"passcode"**: set the profile passcode.
- **The status stays `offline`**: the console is fully switched off (not in
  rest mode) or changed IP address; the integration searches again at most
  every 5 minutes.
- The logs of the integration (Gladys Supervision page) detail every
  error.
