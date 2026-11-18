import { Player, connect } from "./player.js";
import { copyText } from "./clipboard.js";
import { formatTime, formatRemaining } from "./time.js";
const $ = (id) => document.getElementById(id);
let state;
let busy = false;
let settingsDirty = false;
const renameDialog = $("renameDialog");
let renameTargetId = null;
let renameBusy = false;
const report = (error) =>
  ($("error").textContent = error?.message || error || "");
const preview = new Player(
  $("preview"),
  (s) => {
    if (s.error) report(s.error);
  },
  { transparentBackground: true, paused: true, forceMuted: true },
);
const program = new Player(
  $("program"),
  (s) => {
    if (s.error) report(s.error);
  },
  { transparentBackground: true, forceMuted: true },
);
let previewSeq = 0,
  lastPreview;
async function api(url, body, method = "POST") {
  const response = await fetch("/api/" + url, {
    method,
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    let message;
    try {
      message = (await response.json()).error;
    } catch {
      message = "HTTP " + response.status;
    }
    throw Error(message);
  }
  return response.status === 204 ? null : response.json();
}
async function command(action) {
  if (busy && !["black", "clear"].includes(action)) return;
  busy = true;
  try {
    report("");
    await api("command", { action });
    if (["cut", "fade", "take"].includes(action) && $("autoNext").checked)
      await api("command", { action: "next" });
  } catch (e) {
    report(e);
  } finally {
    busy = false;
  }
}
function button(label, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = (event) => {
    event.stopPropagation();
    Promise.resolve().then(fn).catch(report);
  };
  return b;
}
function openRename(img) {
  renameTargetId = img.id;
  $("renameName").value = img.name;
  $("renameError").textContent = "";
  renameDialog.showModal();
  $("renameName").focus();
  $("renameName").select();
}
let librarySignature;
function render() {
  const image = (id) => state.images.find((i) => i.id === id);
  $("previewName").textContent = image(state.preview)?.name || (state.previewMode === "clear" ? "CLEAR（透明）" : "未選択");
  $("programName").textContent =
    image(state.program)?.name ||
    (state.outputMode === "clear" ? "CLEAR（透明）" : "BLACK");
  $("program").classList.toggle(
    "monitor-transparent",
    Boolean(state.program) || state.outputMode === "clear",
  );
  $("imageCount").textContent = state.images.length + "件";
  preview.setMedia(state.images);
  program.setMedia(state.images);
  program.setClock(state.serverTime);
  $("receiverCount").textContent =
    state.receivers.filter((p) => p.connected).length + "台";
  preview.configure(state.settings);
  program.configure(state.settings);
  const previewKey = `${state.previewMode}:${state.preview}`;
  if (lastPreview !== previewKey) {
    lastPreview = previewKey;
    preview.show({
      id: state.preview,
      outputMode: state.previewMode === "clear" ? "clear" : state.preview ? "image" : "black",
      seq: ++previewSeq,
      transition: "cut",
      duration: 0,
    });
  }
  for (const key of ["fit", "background", "fadeMs", "take", "maxVideoUploadMB"]) {
    if (!settingsDirty && document.activeElement !== $(key))
      $(key).value = state.settings[key];
  }
  if (!settingsDirty) {
    $("videoAudio").checked = state.settings.videoMuted !== true;
    $("videoLoop").checked = state.settings.videoLoop === true;
  }
  $("uploadLimit").textContent = `動画${state.settings.maxVideoUploadMB}MBまで`;
  const library = $("library");
  const signature = JSON.stringify(state.images);
  if (signature !== librarySignature) {
    librarySignature = signature;
    for (const video of library.querySelectorAll("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    const libraryScrollTop = library.scrollTop;
    library.replaceChildren();
    state.images.forEach((img, index) => {
      const card = document.createElement("div");
      card.className =
        "card" +
        (img.id === state.preview ? " selected" : "") +
        (img.id === state.program ? " live" : "");
      card.dataset.imageId = img.id;
      card.tabIndex = 0;
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", img.name);
      const selectImage = () =>
        api("command", { action: "preview", id: img.id }).catch(report);
      card.onclick = (event) => {
        if (event.target.closest("button, input, select, textarea, a")) return;
        selectImage();
      };
      card.onkeydown = (event) => {
        if (event.target === card && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          selectImage();
        }
      };
      const isVideo = img.kind === "video";
      const thumb = document.createElement(isVideo ? "video" : "img");
      if (isVideo) {
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = "metadata";
      }
      thumb.src = "/media/" + img.id;
      thumb.alt = img.name;
      thumb.className = "thumb";
      const name = document.createElement("p");
      name.className = "name";
      name.title = img.name;
      name.textContent = img.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${isVideo ? "VIDEO · " + formatTime(img.duration) + (img.hasAudio ? " · 音声あり · " : " · 音声なし · ") : ""}${img.width} × ${img.height} · ${(img.size / 1024 / 1024).toFixed(2)} MB`;
      const move = async (delta) => {
        const ids = state.images.map((i) => i.id),
          to = index + delta;
        if (to < 0 || to >= ids.length) return;
        [ids[index], ids[to]] = [ids[to], ids[index]];
        await api("reorder", { ids });
      };
      const cardPreview = document.createElement("div");
      cardPreview.className = "card-preview";
      const number = document.createElement("span");
      number.className = "card-number";
      number.textContent = "No. " + String(index + 1).padStart(2, "0");
      cardPreview.append(thumb, number);
      const info = document.createElement("div");
      info.className = "card-info";
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "card-actions";
      actions.append(
        button("↑", () => move(-1)),
        button("↓", () => move(1)),
        button("名称変更", () => openRename(img)),
        button("削除", () => {
          if (confirm(img.name + " を削除しますか？"))
            return api("images/" + img.id, undefined, "DELETE");
        }),
      );
      card.append(cardPreview, info, actions);
      library.append(card);
    });
    library.scrollTop = libraryScrollTop;
  }
  for (const card of library.children) {
    card.classList.toggle("selected", card.dataset.imageId === state.preview);
    card.classList.toggle("live", card.dataset.imageId === state.program);
  }
  $("receivers").replaceChildren();
  for (const p of state.receivers) {
    const row = document.createElement("div");
    row.className = "peer";
    row.textContent = `${p.connected ? "● 接続中" : "○ 切断"} ${p.address} / ${p.id.slice(0, 8)} ｜ 最終応答 ${new Date(p.lastSeen).toLocaleTimeString("ja-JP")} ｜ 画像ID ${p.imageId || (p.outputMode === "clear" ? "CLEAR（透明）" : p.outputMode === "black" ? "BLACK" : "未確認")} ｜ SEQ ${p.seq}${p.playback ? " ｜ 動画 " + formatTime(p.playback.currentTime) + " / " + formatTime(p.playback.duration) + " 残り " + formatRemaining(p.playback.duration, p.playback.currentTime) + (p.playback.muted ? "（無音）" : "（音声ON）") : ""}${p.error ? " ｜ エラー: " + p.error : ""}`;
    $("receivers").append(row);
  }
  updateTiming();
}
connect(
  "admin",
  (message) => {
    if (message.type === "state") {
      state = message;
      render();
      program.show({
        id: state.program,
        outputMode: state.outputMode,
        startedAt: state.programStartedAt,
        seq: state.seq,
        transition: "cut",
        duration: 0,
      });
    }
    if (message.type === "program") program.show(message);
  },
  (ok) => {
    $("connection").textContent = ok ? "● サーバー接続中" : "● 切断・再接続中";
    if (!ok) {
      program.seq = -1;
      lastPreview = undefined;
    }
  },
);
document
  .querySelectorAll("[data-command]")
  .forEach((b) => (b.onclick = () => command(b.dataset.command)));
for (const key of [
  "fit",
  "background",
  "fadeMs",
  "take",
  "maxVideoUploadMB",
  "videoAudio",
  "videoLoop",
]) {
  $(key).addEventListener("input", () => {
    settingsDirty = true;
  });
}
$("saveSettings").onclick = () =>
  api("settings", {
    fit: $("fit").value,
    background: $("background").value,
    fadeMs: Number($("fadeMs").value),
    take: $("take").value,
    maxVideoUploadMB: Number($("maxVideoUploadMB").value),
    videoLoop: $("videoLoop").checked,
    videoMuted: !$("videoAudio").checked,
  })
    .then(() => {
      settingsDirty = false;
      report("");
    })
    .catch(report);
async function upload(files) {
  for (const file of files) {
    try {
      const form = new FormData();
      form.append("image", file);
      await api("images", form);
      report("");
    } catch (e) {
      report(file.name + ": " + e.message);
    }
  }
}
$("upload").onchange = (e) => upload(e.target.files);
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  upload(e.dataTransfer.files);
});
document.addEventListener("keydown", (e) => {
  if (renameDialog.open) return;
  if (e.key === "Escape") {
    command("black");
    return;
  }
  if (
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
      document.activeElement.tagName,
    )
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    command("take");
  }
  if (e.key === "ArrowRight") command("next");
});

$("renameCancel").onclick = () => {
  if (!renameBusy) renameDialog.close();
};
renameDialog.addEventListener("cancel", (event) => {
  if (renameBusy) event.preventDefault();
});
renameDialog.addEventListener("close", () => {
  const card = document.querySelector(
    `[data-image-id="${CSS.escape(renameTargetId || "")}"]`,
  );
  card?.focus({ preventScroll: true });
  renameTargetId = null;
});
$("renameForm").onsubmit = async (event) => {
  event.preventDefault();
  if (renameBusy || !renameTargetId) return;
  const name = $("renameName").value.trim();
  if (!name) {
    $("renameError").textContent = "名称を入力してください";
    $("renameName").focus();
    return;
  }
  renameBusy = true;
  $("renameSave").disabled = true;
  $("renameCancel").disabled = true;
  $("renameError").textContent = "";
  try {
    await api("images/" + renameTargetId, { name }, "PATCH");
    renameDialog.close();
  } catch (error) {
    $("renameError").textContent = error.message;
  } finally {
    renameBusy = false;
    $("renameSave").disabled = false;
    $("renameCancel").disabled = false;
  }
};

// Resolve once before the click, preserving the user gesture for HTTP copy fallback.
let outputUrl;
fetch("/api/output-url")
  .then(async (response) => {
    if (!response.ok)
      throw Error(
        "透過OUTのURLを取得できませんでした。ページを再読み込みしてください",
      );
    outputUrl = (await response.json()).url;
    $("copyOutputUrl").disabled = false;
  })
  .catch(report);
let copyStatusTimer;
let copyAttempt = 0;
$("copyOutputUrl").onclick = async () => {
  const attempt = ++copyAttempt;
  clearTimeout(copyStatusTimer);
  $("copyStatus").textContent = "";
  try {
    await copyText(outputUrl);
    if (attempt !== copyAttempt) return;
    $("copyStatus").textContent = "コピーしました";
    copyStatusTimer = setTimeout(() => {
      if (attempt === copyAttempt) $("copyStatus").textContent = "";
    }, 1000);
  } catch (error) {
    if (attempt !== copyAttempt) return;
    $("copyStatus").textContent = "コピーできませんでした";
    report(`${error.message}。URL: ${outputUrl}`);
  }
};

$("monitorAudio").onchange = () => {
  program.forceMuted = !$("monitorAudio").checked;
  if (state) program.configure(state.settings);
  if (program.active?.tagName === "VIDEO" && !program.active.ended)
    program.active.play().catch(report);
};
function updateTiming() {
  if (!state) return;
  const next = state.images.find((item) => item.id === state.preview);
  $("previewDuration").textContent =
    next?.kind === "video" ? formatTime(next.duration) : "--:--.-";
  $("previewMediaState").textContent =
    next?.kind === "video" ? "先頭フレーム・無音" : next ? "静止画" : state.previewMode === "clear" ? "CLEAR（透明）" : "未選択";
  const playback = program.playbackStatus();
  $("programElapsed").textContent = playback
    ? formatTime(playback.currentTime)
    : "--:--.-";
  $("programDuration").textContent = playback
    ? formatTime(playback.duration)
    : "--:--.-";
  $("programRemaining").textContent = playback
    ? formatRemaining(playback.duration, playback.currentTime)
    : "--:--.-";
  $("remainingLabel").textContent = playback?.loop
    ? "次のループまで"
    : "残り時間";
  $("programPlaybackState").textContent = playback
    ? playback.ended
      ? "再生完了"
      : playback.paused
        ? "停止中"
        : playback.loop
          ? "ループ再生中"
          : "再生中"
    : state.outputMode === "clear"
      ? "CLEAR"
      : state.program
        ? state.images.find((item) => item.id === state.program)?.kind ===
          "video"
          ? "準備中"
          : "静止画"
        : "BLACK";
  const failed = state.receivers.find((peer) => peer.connected && peer.error);
  $("programPlaybackState").classList.toggle("playback-warning", !!failed);
  $("programPlaybackState").title = failed?.error || "";
  if (failed) $("programPlaybackState").textContent = "OUT要確認";
}
setInterval(updateTiming, 100);
