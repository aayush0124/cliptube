// ClipTube — Electron main process.
// Spawns yt-dlp (auto-downloaded, self-updating) with bundled ffmpeg to cut
// exact timestamp sections out of YouTube videos.
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Allow the QC harness to attach over CDP.
if (process.env.CLIPTUBE_RDP) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.CLIPTUBE_RDP);
}

const IS_WIN = process.platform === "win32";
const YTDLP_NAME = IS_WIN ? "yt-dlp.exe" : "yt-dlp_macos";
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_NAME}`;

let win = null;
const jobs = new Map(); // id -> {status, progress, file, error, note}

function ytdlpPath() {
  return path.join(app.getPath("userData"), "bin", YTDLP_NAME);
}

function ffmpegPath() {
  // ffmpeg-static resolves inside app.asar; the real binary lives in app.asar.unpacked
  const p = require("ffmpeg-static");
  return p.replace("app.asar", "app.asar.unpacked");
}

function outDir() {
  const d = path.join(app.getPath("downloads"), "ClipTube");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sendSetup(msg, ready) {
  if (win && !win.isDestroyed()) win.webContents.send("setup", { msg, ready });
}

async function ensureYtdlp() {
  const bin = ytdlpPath();
  if (fs.existsSync(bin)) {
    sendSetup("Ready", true);
    // Refresh in the background so YouTube site changes don't break us.
    const up = spawn(bin, ["-U"], { windowsHide: true });
    up.on("error", () => {});
    return;
  }
  sendSetup("First run: downloading yt-dlp engine…", false);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const res = await fetch(YTDLP_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(bin, buf);
  if (!IS_WIN) fs.chmodSync(bin, 0o755);
  sendSetup("Ready", true);
}

// Timestamps: "SS", "MM:SS", "H:MM:SS", optional ".ms"
function parseTs(ts) {
  ts = String(ts || "").trim();
  if (!/^(?:\d+:)?(?:[0-5]?\d:)?[0-5]?\d(?:\.\d{1,3})?$|^\d+(?:\.\d{1,3})?$/.test(ts) || ts === "") {
    throw new Error(`Bad timestamp: "${ts}"`);
  }
  const parts = ts.split(":").map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Bad timestamp: "${ts}"`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function baseArgs() {
  return [
    "--no-playlist",
    "--newline",
    "--windows-filenames",
    "--retries", "10",
    "--fragment-retries", "10",
    // YouTube now demands PO Tokens for its web clients; without a token
    // provider yt-dlp falls back to android_vr, whose stream URLs YouTube
    // then refuses with 403 partway through. These clients need no token and
    // serve URLs that download reliably.
    "--extractor-args", "youtube:player_client=android,web_embedded",
    "--ffmpeg-location", ffmpegPath(),
    // Electron's own binary doubles as the JS runtime yt-dlp needs for YouTube.
    "--js-runtimes", `node:${process.execPath}`,
  ];
}

function runYtdlp(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath(), args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (onLine) String(d).split(/\r?\n/).forEach((l) => l && onLine(l));
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error((err.match(/ERROR:.*$/m) || [err || `yt-dlp exited ${code}`])[0].slice(0, 400)));
    });
  });
}

// yt-dlp's raw errors are jargon ("HTTP Error 403: Forbidden"). Say what the
// user can actually do about it.
function friendlyError(raw) {
  const e = String(raw);
  const map = [
    [/403|unable to download video data|fragment.*not found/i,
      "YouTube refused the download just now. Wait a few seconds and try again — this usually clears on its own."],
    // Age check must precede the bot check: "Sign in to confirm your age"
    // matches both, and the age message is the accurate one.
    [/age[- ]restricted|confirm your age|inappropriate for some users/i,
      "This video is age-restricted and can't be downloaded."],
    [/sign ?in to confirm|not a bot|cookies/i,
      "YouTube asked to verify you're not a bot. Wait a minute and try again."],
    [/private video/i, "This video is private, so it can't be downloaded."],
    [/members[- ]only|join this channel/i, "This video is for channel members only."],
    [/video unavailable|removed by the uploader|has been terminated/i,
      "This video isn't available — it may have been removed or made private."],
    [/is not a valid URL|Unsupported URL/i, "That doesn't look like a YouTube link."],
    [/live event will begin|is live/i, "Live streams aren't supported. Try again once the stream has ended."],
    [/getaddrinfo|ENOTFOUND|Temporary failure|network is unreachable|timed? ?out/i,
      "Can't reach YouTube — check your internet connection."],
    [/no space left|ENOSPC/i, "Your disk is full — free up some space and try again."],
  ];
  for (const [re, msg] of map) if (re.test(e)) return msg;
  return e.replace(/^ERROR:\s*/i, "").slice(0, 300);
}

ipcMain.handle("get-info", async (_e, url) => {
  let out;
  try {
    out = await runYtdlp([...baseArgs(), "-J", "--skip-download", url]);
  } catch (e) {
    throw new Error(friendlyError(e.message));
  }
  const info = JSON.parse(out);
  return {
    title: info.title,
    duration: info.duration,
    thumbnail: info.thumbnail,
    channel: info.channel || info.uploader,
    view_count: info.view_count,
  };
});

function formatFor(quality, audioOnly) {
  if (audioOnly) return ["-f", "bestaudio/best"];
  // Prefer H.264 + M4A so cut-point re-encodes and MP4 muxing stay reliable.
  const h = quality === "best" ? "" : `[height<=${quality}]`;
  const fmt = `bv*[vcodec^=avc1]${h}+ba[ext=m4a]/b[ext=mp4]${h}/bv*${h}+ba/b${h}/b`;
  return ["-f", fmt, "--merge-output-format", "mp4"];
}

function sendJob(id) {
  const job = jobs.get(id);
  if (job) win?.webContents.send("job", { id, ...job });
}

function progressReporter(id, from, to, stage) {
  return (line) => {
    const job = jobs.get(id);
    if (!job) return;
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (m) {
      job.progress = Math.round(from + (parseFloat(m[1]) / 100) * (to - from));
      job.stage = stage;
      sendJob(id);
    }
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-y", "-v", "error", ...args], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`));
    });
  });
}

function findProduced(dir, id) {
  return fs.readdirSync(dir).find((f) => f.startsWith(id) && !/\.(part|ytdl|temp)$/.test(f));
}

// Fast path: yt-dlp downloads only the requested section, exact cuts.
async function clipSection(id, opts) {
  const { url, start, end, quality, audioOnly } = opts;
  const args = [
    ...baseArgs(),
    ...formatFor(quality, audioOnly),
    ...(audioOnly ? ["-x", "--audio-format", "mp3", "--audio-quality", "192K"] : []),
    "--download-sections", `*${start}-${end}`,
    "--force-keyframes-at-cuts",
    "-o", path.join(outDir(), `${id} %(title).70B.%(ext)s`),
    url,
  ];
  await runYtdlp(args, progressReporter(id, 0, 99, "Downloading your section…"));
}

// Guaranteed path: YouTube sometimes rejects ffmpeg's direct stream requests
// (403). Then we download the whole video with yt-dlp's own downloader and cut
// the exact section locally with bundled ffmpeg.
async function clipViaFullDownload(id, opts) {
  const { url, start, end, quality, audioOnly } = opts;
  const tmp = path.join(app.getPath("temp"), "cliptube");
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const args = [
      ...baseArgs(),
      ...formatFor(quality, audioOnly),
      "-N", "4",
      "-o", path.join(tmp, `${id} %(title).70B.%(ext)s`),
      url,
    ];
    await runYtdlp(args, progressReporter(id, 5, 85, "Downloading video…"));
    const full = findProduced(tmp, id);
    if (!full) throw new Error("Download finished but file not found");

    const job = jobs.get(id);
    if (job) { job.progress = 90; job.stage = "Cutting your exact section…"; sendJob(id); }

    const base = path.parse(full).name; // "<id> <title>"
    const dur = String(end - start);
    if (audioOnly) {
      const out = path.join(outDir(), `${base}.mp3`);
      await runFfmpeg(["-ss", String(start), "-i", path.join(tmp, full), "-t", dur,
        "-vn", "-c:a", "libmp3lame", "-b:a", "192k", out]);
    } else {
      const out = path.join(outDir(), `${base}.mp4`);
      await runFfmpeg(["-ss", String(start), "-i", path.join(tmp, full), "-t", dur,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
    }
  } finally {
    for (const f of fs.readdirSync(tmp)) {
      if (f.startsWith(id)) { try { fs.unlinkSync(path.join(tmp, f)); } catch {} }
    }
  }
}

ipcMain.handle("make-clip", async (_e, opts) => {
  const start = parseTs(opts.start || "0");
  const end = parseTs(opts.end);
  if (end <= start) throw new Error("End time must be after start time");
  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, { status: "working", progress: 0 });

  (async () => {
    const job = jobs.get(id);
    const o = { ...opts, start, end };
    const transient = (e) => /ffmpeg exited|403|Postprocessing|fragment|timed? ?out|EOF/i.test(String(e.message));
    const cleanPartial = () => {
      for (const f of fs.readdirSync(outDir())) {
        if (f.startsWith(id)) { try { fs.unlinkSync(path.join(outDir(), f)); } catch {} }
      }
    };
    const attempt = async () => {
      try {
        await clipSection(id, o);
      } catch (e) {
        // Only network/muxing flakiness gets the heavyweight fallback;
        // real errors (private video, bad link) surface immediately.
        if (!transient(e)) throw e;
        cleanPartial();
        await clipViaFullDownload(id, o);
      }
    };
    try {
      // Stream URLs go stale/403 transiently. Each round re-extracts from
      // scratch; backing off between rounds clears nearly all of them.
      const backoffs = [2000, 6000];
      for (let round = 0; ; round++) {
        try {
          await attempt();
          break;
        } catch (e) {
          if (!transient(e) || round >= backoffs.length) throw e;
          cleanPartial();
          job.stage = "YouTube is busy — retrying…";
          sendJob(id);
          await new Promise((r) => setTimeout(r, backoffs[round]));
        }
      }
      const produced = findProduced(outDir(), id);
      if (!produced) throw new Error("Finished but no output file found");
      Object.assign(job, { status: "done", progress: 100, file: path.join(outDir(), produced) });
    } catch (e) {
      Object.assign(job, { status: "error", error: friendlyError(e.message) });
    }
    sendJob(id);
  })();

  return id;
});

ipcMain.handle("open-file", (_e, p) => shell.openPath(p));
ipcMain.handle("show-file", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("open-folder", () => shell.openPath(outDir()));

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 900,
    minWidth: 560,
    minHeight: 640,
    backgroundColor: "#262624",
    autoHideMenuBar: true,
    title: "ClipTube",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  win.webContents.once("did-finish-load", () => {
    ensureYtdlp().catch((e) => sendSetup(`Setup failed: ${e.message}`, false));
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
