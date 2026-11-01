# Vitrine

Self-hosted digital signage. Upload content, build playlists, schedule them, and put them on any display with a browser. There's no cloud, no account with anyone, and no per-screen fee.

## Quick start

You need [Node.js](https://nodejs.org) 22.13 or newer. Node 24 is what it's tested on.

```sh
npm install
npm start
```

Open <http://localhost:3400> and create the owner account. **Do this straight away on a shared network**, because the first person to open a new install becomes the owner.

To connect a display:

1. On the display, open `http://YOUR-SERVER:3400/tv`. It shows a six-character code.
2. In the studio, go to **Screens > Add a screen** and enter the code.

For displays that should start by themselves, use `scripts/kiosk-raspberry-pi.sh` or `scripts/kiosk-windows.ps1`. Smart TVs can open the address in their built-in browser.

FFmpeg is optional, and only needed for RTSP and RTMP cameras.

### Docker

```sh
docker compose up -d
```

The image includes FFmpeg, and data is kept in the `vitrine-data` volume.

## What it does

**Content:** images, videos, web pages, YouTube, an HTML editor with live preview, styled and scrolling text, PDF import (each page becomes an image), live streams (HLS, MJPEG, or RTSP/RTMP via FFmpeg), server folders, and compositions (multi-zone layouts where a zone can rotate a whole playlist). Plugins add a clock, countdown, QR code, news feed, and weather.

**Playlists:** drag-and-drop order, per-slide durations, transitions, repeat counts, and playlists inside playlists. Each slide can play always, between two dates, in a weekly window, or during daily hours.

**Screens:** pairing by code, groups, rotation, time rules that switch playlists or turn a screen off by time of day, live status and now-playing, and remote identify, refresh and reload.

**Broadcast:** one action interrupts all or chosen screens with a full-screen message or banner, with an automatic end time.

**Insights:** proof of play by item, screen and day, with CSV export.

**Offline:** players store the schedule and media locally, keep playing while the server is down, and upload their play history when it returns. See [Offline behaviour](#offline-behaviour).

**Administration:** owner, admin, content manager and device manager roles; teams that separate content; two-factor sign-in; an activity log; white-label name, logo and color; English, French and Spanish.

**Integrations:** a REST API with tokens (reference under Settings > Integrations, spec at `/api/openapi.json`), signed webhooks for n8n, Zapier and similar tools, and a plugin system (see `plugins/README.md`).

## Player URLs

| URL | Use |
| --- | --- |
| `/tv` | A paired screen. This is the normal choice. |
| `/use/<playlist id>` | One playlist, no pairing. Needs public links on (Settings > General). |
| `/group/<group id>` | A group's playlist, no pairing. Needs public links on. |

These query parameters work on all of them:

| Parameter | Values | Default |
| --- | --- | --- |
| `intro` | `0`, `1` | `1` |
| `rotate` | `normal`, `left`, `right`, `inverted` | `normal` |
| `transparent` | `0`, `1` | `0` |
| `bgcolor` | hex without `#` | `000000` |
| `animation_effect` | `fade`, `slide`, `zoom`, `wipe`, `none` | playlist setting |
| `animation_speed` | `slow`, `normal`, `fast` | playlist setting |
| `animation_direction` | `left`, `right`, `up`, `down` | playlist setting |
| `interactive` | `0`, `1` | `1` |
| `loop` | number of repeats, `0` for endless | playlist setting |
| `debug` | `0`, `1` | `0` |

## Configuration

Set these as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3400` / `0.0.0.0` | Where to listen |
| `VITRINE_DATA_DIR` | `./data` | Database and media |
| `VITRINE_SSL_CERT`, `VITRINE_SSL_KEY` | none | Paths to a certificate and key, to serve HTTPS directly |
| `VITRINE_MAX_UPLOAD_MB` | `2048` | Upload limit |
| `VITRINE_FOLDER_ROOTS` | `<data>/external` | Directories that Folder content may read, separated by `;` on Windows and `:` elsewhere |
| `VITRINE_FFMPEG` | `ffmpeg` | Path to FFmpeg |
| `VITRINE_TRUST_PROXY` | `false` | Set to `true` only behind a reverse proxy |
| `VITRINE_SESSION_DAYS` | `14` | How long a sign-in lasts |
| `VITRINE_STATS_RETENTION_DAYS` | `365` | How long play history is kept |

Put HTTPS in front of it if the studio is reachable beyond a network you trust. Without it, passwords and session cookies travel unencrypted.

## Offline behaviour

- **The player keeps running through an outage on any network.** Schedules are evaluated on the player using its own clock, so check that displays have the right time and time zone.
- **Reloading or restarting the display during an outage only works on HTTPS or `localhost`.** Browsers allow service workers only there. On plain HTTP, a display that reboots while the server is down waits for the server.
- Web pages, YouTube, live streams and plugin content need the network, and are skipped while offline.

## Backup and restore

The owner can download a database snapshot from Settings > General. Keep the `data/media` folder as well, because it holds your uploaded files. To restore, stop the server, put the snapshot at `data/vitrine.db` and the media back in `data/media`, then start it again.

## Locked out?

Run this on the server. It resets the password and clears two-factor:

```sh
npm run reset-password -- <username> <new-password>
```

## Development

```sh
npm run dev         # restart on change
npm test            # scheduling logic and API tests
npm run i18n:check  # find untranslated strings
```

There is no build step. `server/` is Express with Node's built-in SQLite, `public/app/` is the studio, `public/player/` is what runs on screens, and `shared/schedule.js` is the scheduling logic both sides use.

## Known limits

- Videos may start muted until someone interacts with the display, which is a browser rule. The kiosk scripts pass the flag that lifts it.
- Many websites refuse to appear inside another page. Nothing on the player's side can override that.
- Server-side stream conversion needs enough CPU for one FFmpeg process per camera being watched.
