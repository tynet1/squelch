# Squelch

A headless OP25 P25 trunked radio remote — stream audio, monitor calls, and manage talkgroups from your iPad (or any browser) over Tailscale.

![Monitor tab showing live call with talkgroup, RSSI, and audio controls](https://img.shields.io/badge/status-beta-yellow) ![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

- **Streams live P25 audio** to your browser via MP3 (iOS Safari compatible)
- **Real-time status** via WebSocket — current talkgroup, frequency, RSSI, NAC, source unit
- **Mute talkgroups** client-side per-TG, persisted across sessions
- **Auto-lockout** — mark a TG locked out and Squelch fires the OP25 lockout command the instant it goes active
- **Record calls** server-side to MP3, download or delete from the Status tab
- **RadioReference import** — paste a RR system URL and it fetches control channels, NAC, WACN, and system name automatically
- **Service dashboard** — live systemd status for `op25` and `op25-web` with one-tap restart buttons
- **Three-tab UI** optimized for iPad: Monitor · Groups · Status

---

## Hardware

| Item | Notes |
|------|-------|
| RTL-SDR dongle | RTL-SDR Blog V3 recommended |
| Linux box | Ubuntu 22.04 LTS tested; Debian 12 should work |
| Tailscale | Already installed on the host — access from anywhere |

One RTL-SDR = one role (OP25 **or** ADS-B, not both simultaneously). Need ADS-B too? That's a separate project and a second dongle.

---

## Install

```bash
git clone https://github.com/tynet1/squelch.git
cd squelch
chmod +x install.sh
./install.sh
```

The install script will:

1. Install system packages (`gnuradio`, `gr-osmosdr`, `rtl-sdr`, `ffmpeg`, etc.)
2. Clone and build [boatbod/op25](https://github.com/boatbod/op25)
3. Set up RTL-SDR udev rules and add your user to `plugdev`
4. Create a Python venv and install server dependencies
5. Register `op25.service` and `op25-web.service` with systemd

> ⚠️ The OP25 build takes a few minutes — gnuradio OOT modules require a full cmake compile.

---

## Configure

Before starting, edit `config/trunk.tsv` with your P25 system info.

**Option A — RadioReference import (easiest)**

1. Start `op25-web` first: `sudo systemctl start op25-web`
2. Open Squelch in your browser, tap **⚙ → Fetch** and paste your RadioReference system URL
3. Verify the populated fields and tap **Save to trunk.tsv**

**Option B — Manual**

Edit `config/trunk.tsv` directly. The format is tab-separated:

```
Sys Name	Control Channel List	Offset	NAC	WACN	SYSID	...
My County P25	851.0125,851.5125,852.0125	0	659	782336	419
```

- **Control Channel List** — comma-separated MHz frequencies
- **NAC** — decimal (e.g. `0x293` hex = `659` decimal)
- **WACN / SYSID** — from RadioReference system page; use `0` if unknown

---

## Start

```bash
sudo systemctl start op25 op25-web
```

Then open `http://<your-machine-ip>:8888` — or `http://<tailscale-hostname>:8888` from your iPad.

```bash
# Follow logs
sudo journalctl -u op25 -f
sudo journalctl -u op25-web -f

# Stop everything
sudo systemctl stop op25 op25-web

# Enable auto-start on boot
sudo systemctl enable op25 op25-web
```

---

## Architecture

```
RTL-SDR
  └─▶  OP25 rx.py  (headless, port 8080)
              │
              ├─ /status.json   ◀─── WebSocket broadcaster (1s poll)
              ├─ /talkgroups         FastAPI proxy
              ├─ /hold, /skip,       (port 8888)
              │   /lockout, /scan         │
              └─ /feed (raw PCM) ──▶ ffmpeg ──▶ /stream (MP3)
                                         │
                                    Static web UI
                                  (iPad-optimized SPA)
```

| Component | Stack |
|-----------|-------|
| Backend | Python · FastAPI · uvicorn |
| Audio transcode | ffmpeg (PCM 8kHz → MP3 22kHz) |
| Frontend | Vanilla JS · CSS custom properties |
| Persistence | localStorage (mute/lockout lists) |
| Transport | WebSocket (status) · HTTP streaming (audio) |

---

## UI

### Monitor tab
Live call display with talkgroup ID, name, frequency, source unit, NAC, and RSSI bar. Tap the speaker icon to mute the current TG. HOLD / SKIP / LOCKOUT / SCAN controls. Recent calls list — tap any entry to hold it, tap the speaker to mute it.

### Groups tab
Full talkgroup list from OP25, searchable. Per-row mute (🔇) and lockout (⊘) toggles. Active call tracked with a live green dot. Mute and lockout state persists in `localStorage`.

### Status tab
Live systemd status for `op25` and `op25-web` with restart buttons. Dependency checks: OP25 API · ffmpeg · RTL-SDR USB. Recordings list with download and delete.

---

## Talkgroup management

| Action | Effect |
|--------|--------|
| **Mute** | Silences audio in your browser when that TG is active. OP25 keeps decoding. Persists in localStorage. |
| **Lockout** | Sends the OP25 lockout command the instant that TG goes active. OP25 skips to the next call. Persists in localStorage. |
| **Hold** | Tells OP25 to stay on the current TG. |
| **Skip** | Tells OP25 to move to the next call. |

---

## Recording

Tap the red dot button (⏺) in the audio section to start recording. Audio is saved server-side to `recordings/squelch_YYYYMMDD_HHMMSS.mp3`. Download or delete recordings from the Status tab. A concurrent recording limit of one is enforced.

---

## Security note

Squelch has **no authentication**. It's designed to run on a private Tailscale network — do not expose port 8888 to the public internet. If you need auth, add a Tailscale ACL or drop nginx in front with HTTP basic auth.

---

## Troubleshooting

**RTL-SDR not detected**
```bash
lsusb | grep -i realtek   # should show 0bda:2832 or 0bda:2838
sudo usermod -a -G plugdev $USER && newgrp plugdev
```

**OP25 won't start / no audio**
```bash
sudo journalctl -u op25 -n 50
# Check trunk.tsv control channel frequencies are correct for your system
```

**Audio stream doesn't play on iPad**
- iOS requires a user gesture to start audio — tap the play button, don't try to auto-play
- Make sure you're accessing over HTTP (not a mixed-content HTTPS page)

**RadioReference fetch returns no channels**
- Some RR pages require a login for full data — try pasting control channels manually
- The parser targets the 700/800 MHz band; adjust `freq_pattern` in `server/main.py` for other bands

---

## License

MIT
