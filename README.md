# ClipTube ✂️

Desktop app (Windows + macOS) that downloads **exactly the part you need** from any
YouTube video — paste a link, set start/end timestamps, get an MP4 (or MP3) clip.

![icon](build/icon.png)

## Features
- Timestamp-accurate cuts (`SS`, `MM:SS`, `H:MM:SS`)
- Quality picker: 480p / 720p / 1080p / best
- Audio-only MP3 mode
- Only downloads the requested section — long videos clip fast
- ffmpeg is bundled; the yt-dlp engine auto-installs on first run and
  self-updates, so YouTube site changes don't break the app
- Clips saved to `Downloads/ClipTube`

## Development
```
npm install
npm start
```

## Build installers
- Windows (on Windows): `npm run dist:win` → `dist/ClipTube Setup 1.0.0.exe`
- macOS (on a Mac): `npm run dist:mac` → `dist/ClipTube-1.0.0-universal.dmg`
- Both via CI: push a `v*` tag (or run the workflow manually) — GitHub Actions
  builds Windows + macOS installers as artifacts. Mac DMGs can only be built on
  macOS, which is why CI handles it.

Installers are unsigned: Windows SmartScreen shows "More info → Run anyway";
on macOS right-click → Open the first time (or notarize with an Apple
Developer ID to remove the prompt).

## Troubleshooting

**"This file does not have an app associated with it" when clicking the
ClipTube shortcut** — the shortcut outlived its target. Two causes:

1. *Installed while elevated.* Don't right-click → "Run as administrator" on
   the installer. It is a per-user install: elevating puts the app in the
   admin account's AppData while the shortcut lands in yours, so the shortcut
   points at a path that doesn't exist for you. From v1.0.1 the installer asks
   who to install for and elevates only when needed, which avoids this.
2. *Antivirus quarantined the app.* ClipTube is unsigned and downloads its
   yt-dlp engine from GitHub, which some corporate endpoint AV flags. Check
   the AV's quarantine/protection history, restore and allow it, reinstall.

To tell which one, check whether the app survived:
```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\cliptube\ClipTube.exe","C:\Program Files\ClipTube\ClipTube.exe" -ErrorAction SilentlyContinue
```
A path printed means only the shortcut broke — launch it from there. Nothing
printed means the app is gone (cause 2).

## QC harness
`node qc/e2e.js` drives the real UI over the Chrome DevTools Protocol:
fetches a video, cuts a clip, and verifies the output file's duration with
ffprobe. Works against both dev mode and the packaged exe.
