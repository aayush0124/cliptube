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

## QC harness
`node qc/e2e.js` drives the real UI over the Chrome DevTools Protocol:
fetches a video, cuts a clip, and verifies the output file's duration with
ffprobe. Works against both dev mode and the packaged exe.
