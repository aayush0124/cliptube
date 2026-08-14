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

const PORT = 9223;
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
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
    } catch (e) {
      if (Date.now() > until) throw new Error("Could not attach to app via CDP: " + e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function waitFor(page, fn, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() > until) throw new Error("Timed out waiting for: " + what);
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function setInput(page, sel, value) {
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, sel, value);
}

async function runClipTest(page, name, { url, start, end, quality = "720", audioOnly = false, expectSec, tolerance = 0.5, ext }) {
  await page.evaluate(() => document.getElementById("resetBtn").click());
  await setInput(page, "#url", url);
  await page.click("#fetchBtn");
  await waitFor(page, () => document.getElementById("urlHint").textContent.includes("Video found"), 90_000, "video info");
  await setInput(page, "#start", start);
  await setInput(page, "#end", end);
  await page.select("#quality", quality);
  await page.evaluate((a) => { document.getElementById("audioOnly").checked = a; }, audioOnly);
  await page.click("#goBtn");
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
  const file = await page.evaluate(() => currentFile);
  if (!file || !fs.existsSync(file)) throw new Error("Output file missing: " + file);
  if (ext && !file.toLowerCase().endsWith(ext)) throw new Error(`Expected ${ext}, got ${path.basename(file)}`);
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

  console.log(`Launching: ${spawnCmd.cmd} ${spawnCmd.args.join(" ")}`);
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
      start: "0:02", end: "0:10", expectSec: 8, ext: ".mp4",
    });
    record("720p video clip (8s, exact)", true, d);
  } catch (e) { record("720p video clip (8s, exact)", false, e.message); }

  // 3. "Best" quality on a 4K/VP9-heavy video — the case that crashed v1
  try {
    const d = await runClipTest(page, "clip4k", {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      start: "1:00", end: "1:12", quality: "best", expectSec: 12, ext: ".mp4",
    });
    record("Best-quality clip from 4K video (12s)", true, d);
  } catch (e) { record("Best-quality clip from 4K video (12s)", false, e.message); }

  // 4. Audio-only MP3
  try {
    const d = await runClipTest(page, "mp3", {
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      start: "0:03", end: "0:09", audioOnly: true, expectSec: 6, tolerance: 1.2, ext: ".mp3",
    });
    record("Audio-only MP3 clip (6s)", true, d);
  } catch (e) { record("Audio-only MP3 clip (6s)", false, e.message); }

  // 5. Bad URL shows a friendly error
  try {
    await setInput(page, "#url", "https://www.youtube.com/watch?v=not_a_real_id00");
    await page.click("#fetchBtn");
    await waitFor(page, () => document.querySelector("#urlHint .msg-err") !== null, 60_000, "bad-url error");
    record("Bad URL → friendly error", true);
  } catch (e) { record("Bad URL → friendly error", false, e.message); }

  // 6. End before start rejected
  try {
    await setInput(page, "#url", "https://www.youtube.com/watch?v=jNQXAC9IVRw");
    await setInput(page, "#start", "0:10");
    await setInput(page, "#end", "0:05");
    await page.click("#goBtn");
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
