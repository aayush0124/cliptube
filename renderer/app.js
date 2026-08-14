const $ = (id) => document.getElementById(id);
let currentJob = null;
let currentFile = null;

function fmtDur(s) {
  if (s == null) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(sec).padStart(2, "0");
}

window.clip.onSetup(({ msg, ready }) => {
  if (ready) {
    $("setup").classList.remove("show");
  } else {
    $("setup").classList.add("show");
    $("setupMsg").textContent = msg;
  }
});

async function fetchInfo() {
  const url = $("url").value.trim();
  if (!url) return;
  $("fetchBtn").disabled = true;
  $("urlHint").textContent = "Fetching video info…";
  try {
    const d = await window.clip.getInfo(url);
    $("thumb").src = d.thumbnail || "";
    $("vTitle").textContent = d.title || "";
    $("vSub").textContent = [
      d.channel,
      fmtDur(d.duration),
      d.view_count ? d.view_count.toLocaleString() + " views" : null,
    ].filter(Boolean).join(" · ");
    $("preview").classList.add("show");
    $("urlHint").textContent = "Video found ✓ — set your timestamps below.";
    if (d.duration && !$("end").value) $("end").placeholder = fmtDur(d.duration);
  } catch (e) {
    $("preview").classList.remove("show");
    $("urlHint").innerHTML = '<span class="msg-err">' + cleanErr(e) + "</span>";
  } finally {
    $("fetchBtn").disabled = false;
  }
}

function cleanErr(e) {
  return String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

async function startClip() {
  const opts = {
    url: $("url").value.trim(),
    start: $("start").value.trim() || "0",
    end: $("end").value.trim(),
    quality: $("quality").value,
    audioOnly: $("audioOnly").checked,
  };
  if (!opts.url) { $("urlHint").innerHTML = '<span class="msg-err">Paste a YouTube link first.</span>'; return; }
  if (!opts.end) { $("urlHint").innerHTML = '<span class="msg-err">Set an end time for your clip.</span>'; return; }
  $("goBtn").disabled = true;
  $("status").classList.add("show");
  $("done-row").classList.remove("show");
  $("barFill").style.width = "0%";
  $("pct").textContent = "0%";
  $("statusMsg").textContent = "Starting…";
  try {
    currentJob = await window.clip.makeClip(opts);
  } catch (e) {
    $("statusMsg").innerHTML = '<span class="msg-err">' + cleanErr(e) + "</span>";
    $("goBtn").disabled = false;
  }
}

window.clip.onJob((d) => {
  if (d.id !== currentJob) return;
  if (d.status === "working") {
    $("barFill").style.width = d.progress + "%";
    $("pct").textContent = d.progress + "%";
    $("statusMsg").textContent = d.stage || "Downloading & cutting your section…";
  } else if (d.status === "done") {
    currentFile = d.file;
    $("barFill").style.width = "100%";
    $("pct").textContent = "100%";
    $("statusMsg").innerHTML = '<span class="msg-ok">Clip ready ✓' + (d.note ? " · " + d.note : "") + "</span>";
    $("done-row").classList.add("show");
    $("goBtn").disabled = false;
  } else if (d.status === "error") {
    $("statusMsg").innerHTML = '<span class="msg-err">' + (d.error || "Something went wrong") + "</span>";
    $("goBtn").disabled = false;
  }
});

$("fetchBtn").addEventListener("click", fetchInfo);
$("goBtn").addEventListener("click", startClip);
$("openBtn").addEventListener("click", () => currentFile && window.clip.openFile(currentFile));
$("showBtn").addEventListener("click", () => currentFile && window.clip.showFile(currentFile));
$("folderLink").addEventListener("click", () => window.clip.openFolder());
$("resetBtn").addEventListener("click", () => {
  $("status").classList.remove("show");
  $("start").value = "";
  $("end").value = "";
});
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchInfo(); });
