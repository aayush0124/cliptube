/* ClipTube end-to-end QC.
 * Launches the app (dev or packaged), drives the real UI via CDP, and
 * verifies produced files with ffprobe.
 *
 *   node qc/e2e.js                 → dev mode (npx electron .)
 *   node qc/e2e.js <path-to-exe>   → packaged app
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

// A fixed port lets a stale app from an earlier run answer the CDP handshake,
// after which every evaluate() hits a detached frame. Fresh port per run.
const PORT = 9300 + Math.floor(Math.random() * 600);
const ROOT = path.join(__dirname, "..");
const results = [];
let appProc = null;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function ffprobeDuration(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(String(out));
}

async function connectWithRetry(deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null, protocolTimeout: 600_000 });
    } catch (e) {
      if (Date.now() > until) throw new Error("Could not attach to app via CDP: " + e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// CDP calls to Electron hiccup non-deterministically (transient
// "Runtime.callFunctionOn timed out" / detached frame). A blip during polling
// is not a product failure, so swallow it and keep polling until the deadline;
// only a truly closed target aborts.
async function evalSafe(page, fn, arg) {
  try {
    return { ok: true, value: await page.evaluate(fn, arg) };
  } catch (e) {
    const msg = String(e.message);
    if (/Target closed|Session closed|browser has disconnected/i.test(msg)) throw e;
    return { ok: false, error: msg };
  }
}

async function waitFor(page, fn, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  let lastBlip = null;
  for (;;) {
    const r = await evalSafe(page, fn);
    if (r.ok && r.value) return r.value;
    if (!r.ok) lastBlip = r.error;
    if (Date.now() > until) {
      throw new Error(`Timed out waiting for: ${what}${lastBlip ? ` (last CDP blip: ${lastBlip.slice(0, 60)})` : ""}`);
    }
    await new Promise((r2) => setTimeout(r2, 800));
  }
}

async function setInput(page, sel, value) {
  // Retry through transient CDP blips rather than failing the whole check.
  for (let i = 0; ; i++) {
    const r = await evalSafe(page, ({ s, v }) => {
      const el = document.querySelector(s);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, { s: sel, v: value });
    if (r.ok) return;
    if (i >= 3) throw new Error(`setInput(${sel}) failed: ${r.error}`);
    await new Promise((r2) => setTimeout(r2, 1500));
  }
}

async function clickSafe(page, sel) {
  for (let i = 0; ; i++) {
    const r = await evalSafe(page, (s) => { document.querySelector(s).click(); return true; }, sel);
    if (r.ok) return;
    if (i >= 3) throw new Error(`click(${sel}) failed: ${r.error}`);
    await new Promise((r2) => setTimeout(r2, 1500));
  }
}

async function runClipTest(page, name, { url, start, end, quality = "720", audioOnly = false, expectSec, tolerance = 0.5, ext, expectTitle }) {
  await clickSafe(page, "#resetBtn");
  // Clear the hint so a stale "Video found" from the previous test can't let
  // the next wait pass instantly.
  await evalSafe(page, () => { document.getElementById("urlHint").textContent = ""; });
  await setInput(page, "#url", url);
  await clickSafe(page, "#fetchBtn");
  await waitFor(page, () => document.getElementById("urlHint").textContent.includes("Video found"), 90_000, "video info");
  await setInput(page, "#start", start);
  await setInput(page, "#end", end);
  await setInput(page, "#quality", quality);
  await evalSafe(page, (a) => { document.getElementById("audioOnly").checked = a; }, audioOnly);
  await clickSafe(page, "#goBtn");
  const msg = await waitFor(
    page,
    () => {
      const t = document.getElementById("statusMsg").textContent;
      return /Clip ready|wrong|ERROR|error/i.test(t) ? t : null;
    },
    420_000,
    "clip finish"
  );
  if (!/Clip ready/.test(msg)) throw new Error("Clip failed: " + msg);
  // `currentFile` is a top-level `let` in the renderer, so it lives in the
  // global lexical scope, not on `window` — reference it bare.
  const file = await waitFor(page, () => (typeof currentFile !== "undefined" ? currentFile : null), 30_000, "output file path");
  if (!file || !fs.existsSync(file)) throw new Error("Output file missing: " + file);
  if (ext && !file.toLowerCase().endsWith(ext)) throw new Error(`Expected ${ext}, got ${path.basename(file)}`);
  // Duration alone can pass while the wrong video was fetched — check identity too.
  if (expectTitle && !path.basename(file).includes(expectTitle)) {
    throw new Error(`Wrong video: expected "${expectTitle}" in ${path.basename(file)}`);
  }
  const dur = ffprobeDuration(file);
  const snapped = /snapped/.test(msg);
  const tol = snapped ? 4 : tolerance;
  if (Math.abs(dur - expectSec) > tol) {
    throw new Error(`Duration ${dur.toFixed(2)}s, expected ${expectSec}s ±${tol}${snapped ? " (keyframe fallback)" : ""}`);
  }
  return `${path.basename(file)} · ${dur.toFixed(2)}s${snapped ? " (keyframe fallback)" : ""}`;
}

(async () => {
  const target = process.argv[2];
  const spawnCmd = target
    ? { cmd: target, args: [] }
    : os.platform() === "win32"
      ? { cmd: path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), args: ["."] }
      : { cmd: "npx", args: ["electron", "."] };

  // Leftover instances (installer's run-after-finish, a killed prior run)
  // compete for the app and confuse the debugger attach.
  try {
    if (os.platform() === "win32") execFileSync("taskkill", ["/F", "/IM", "ClipTube.exe", "/T"], { stdio: "ignore" });
    else execFileSync("pkill", ["-f", "ClipTube"], { stdio: "ignore" });
  } catch { /* nothing running */ }

  console.log(`Launching: ${spawnCmd.cmd} ${spawnCmd.args.join(" ")}  (CDP port ${PORT})`);
  appProc = spawn(spawnCmd.cmd, spawnCmd.args, {
    cwd: ROOT,
    env: { ...process.env, CLIPTUBE_RDP: String(PORT) },
    stdio: "ignore",
  });

  const browser = await connectWithRetry(30_000);
  const page = (await browser.pages()).find((p) => p.url().includes("index.html")) || (await browser.pages())[0];

  // 1. App booted, setup finished (first run may download yt-dlp)
  try {
    await waitFor(page, () => !document.getElementById("setup").classList.contains("show"), 180_000, "yt-dlp setup");
    record("App boots & engine ready", true);
  } catch (e) {
    record("App boots & engine ready", false, e.message);
    throw e;
  }

  // 2. Video clip, 720p, exact cut
  try {
    const d = await runClipTest(page, "clip", {
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      start: "0:02", end: "0:10", expectSec: 8, ext: ".mp4", expectTitle: "Me at the zoo",
    });
    record("720p video clip (8s, exact)", true, d);
  } catch (e) { record("720p video clip (8s, exact)", false, e.message); }

  // 3. "Best" quality on a 4K/VP9-heavy video — the case that crashed v1
  try {
    const d = await runClipTest(page, "clip4k", {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      start: "1:00", end: "1:12", quality: "best", expectSec: 12, ext: ".mp4", expectTitle: "Big Buck Bunny",
    });
    record("Best-quality clip from 4K video (12s)", true, d);
  } catch (e) { record("Best-quality clip from 4K video (12s)", false, e.message); }

  // 4. Audio-only MP3
  try {
    const d = await runClipTest(page, "mp3", {
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      start: "0:03", end: "0:09", audioOnly: true, expectSec: 6, tolerance: 1.2, ext: ".mp3", expectTitle: "Me at the zoo",
    });
    record("Audio-only MP3 clip (6s)", true, d);
  } catch (e) { record("Audio-only MP3 clip (6s)", false, e.message); }

  // 5. Long video + deep timestamp + 1080p — the real-world case that shipped
  // broken in v1.0.2: YouTube 403s the android_vr fallback on videos like this.
  try {
    const d = await runClipTest(page, "long", {
      url: "https://www.youtube.com/watch?v=pWFwDD5r-JI",
      start: "20:25", end: "21:59", quality: "1080", expectSec: 94, tolerance: 1.5,
      ext: ".mp4", expectTitle: "National Address",
    });
    record("Long video, deep timestamp, 1080p (94s)", true, d);
  } catch (e) { record("Long video, deep timestamp, 1080p (94s)", false, e.message); }

  // 6. Bad URL shows a friendly error
  try {
    await setInput(page, "#url", "https://www.youtube.com/watch?v=not_a_real_id00");
    await clickSafe(page, "#fetchBtn");
    await waitFor(page, () => document.querySelector("#urlHint .msg-err") !== null, 60_000, "bad-url error");
    record("Bad URL → friendly error", true);
  } catch (e) { record("Bad URL → friendly error", false, e.message); }

  // 7. End before start rejected
  try {
    await setInput(page, "#url", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await setInput(page, "#start", "0:10");
    await setInput(page, "#end", "0:05");
    await clickSafe(page, "#goBtn");
    await waitFor(page, () => /after start/.test(document.getElementById("statusMsg").textContent), 20_000, "validation error");
    record("End ≤ start rejected", true);
  } catch (e) { record("End ≤ start rejected", false, e.message); }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  browser.disconnect();
  appProc.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("QC aborted:", e.message);
  if (appProc) appProc.kill();
  process.exit(1);
});
