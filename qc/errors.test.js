/* Unit test for friendlyError(). Pulls the function out of main.js so the
 * mapping is tested without booting Electron.
 *   node qc/errors.test.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const fn = src.match(/function friendlyError\(raw\) \{[\s\S]*?\n\}/);
if (!fn) { console.error("FAIL: could not locate friendlyError in main.js"); process.exit(1); }
const friendlyError = new Function(`${fn[0]}; return friendlyError;`)();

// [raw yt-dlp error, substring the user should see]
const cases = [
  ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "Wait a few seconds"],
  ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "private"],
  ["ERROR: [youtube] abc: Video unavailable", "isn't available"],
  ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", "not a bot"],
  ["ERROR: [youtube] abc: Sign in to confirm your age", "age-restricted"],
  ["ERROR: [youtube] abc: Join this channel to get access to members-only content", "members only"],
  ["ERROR: unable to download webpage: getaddrinfo ENOTFOUND www.youtube.com", "internet connection"],
  ["ERROR: unable to write data: No space left on device", "disk is full"],
  ["ERROR: 'not a link' is not a valid URL", "YouTube link"],
  ["ERROR: [youtube] abc: This live event will begin in 2 hours", "Live streams"],
  // Must NOT be mis-mapped: "webpage"/"message" contain the substring "age"
  ["ERROR: unable to download webpage: HTTP Error 500", "HTTP Error 500"],
  ["ERROR: Postprocessing: something odd happened", "Postprocessing"],
];

let failed = 0;
for (const [raw, expect] of cases) {
  const got = friendlyError(raw);
  const ok = got.toLowerCase().includes(expect.toLowerCase());
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${raw.slice(0, 52).padEnd(54)} -> ${got}`);
}
// Raw "ERROR:" prefix should never survive to the UI
const prefixed = friendlyError("ERROR: something totally unrecognised");
if (/^ERROR:/i.test(prefixed)) { console.log("FAIL  ERROR: prefix not stripped"); failed++; }
else console.log("PASS  ERROR: prefix stripped");

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
