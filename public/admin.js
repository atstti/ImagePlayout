import { Player, connect } from "./player.js";
import { copyText } from "./clipboard.js";
const $ = (id) => document.getElementById(id);
let state;
let busy = false;
let settingsDirty = false;
const report = (error) =>
  ($("error").textContent = error?.message || error || "");
const preview = new Player(
  $("preview"),
  (s) => {
    if (s.error) report(s.error);
  },
  { transparentBackground: true },
);
const program = new Player(
  $("program"),
  (s) => {
    if (s.error) report(s.error);
  },
  { transparentBackground: true },
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
  b.textContent = label;
  b.onclick = () => Promise.resolve().then(fn).catch(report);
  return b;
}
function render() {
  const image = (id) => state.images.find((i) => i.id === id);
  $("previewName").textContent = image(state.preview)?.name || "未選択";
  $("programName").textContent =
    image(state.program)?.name ||
    (state.outputMode === "clear" ? "CLEAR（透明）" : "BLACK");
  $("program").classList.toggle(
    "monitor-transparent",
    Boolean(state.program) || state.outputMode === "clear",
  );
  $("imageCount").textContent = state.images.length + "枚";
  $("receiverCount").textContent =
    state.receivers.filter((p) => p.connected).length + "台";
  preview.configure(state.settings);
  program.configure(state.settings);
  if (lastPreview !== state.preview) {
    lastPreview = state.preview;
    preview.show({
      id: state.preview,
      seq: ++previewSeq,
      transition: "cut",
      duration: 0,
    });
  }
  for (const key of ["fit", "background", "fadeMs", "take"]) {
    if (!settingsDirty && document.activeElement !== $(key))
      $(key).value = state.settings[key];
  }
  const library = $("library");
  library.replaceChildren();
  state.images.forEach((img, index) => {
    const card = document.createElement("div");
    card.className =
      "card" +
      (img.id === state.preview ? " selected" : "") +
      (img.id === state.program ? " live" : "");
    const thumb = document.createElement("img");
    thumb.src = "/media/" + img.id;
    thumb.alt = img.name;
    thumb.className = "thumb";
    thumb.onclick = () =>
      api("command", { action: "preview", id: img.id }).catch(report);
    const name = document.createElement("p");
    name.className = "name";
    name.textContent = String(index + 1).padStart(2, "0") + "  " + img.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${img.width} × ${img.height} · ${(img.size / 1024 / 1024).toFixed(2)} MB`;
    const move = async (delta) => {
      const ids = state.images.map((i) => i.id),
        to = index + delta;
      if (to < 0 || to >= ids.length) return;
      [ids[index], ids[to]] = [ids[to], ids[index]];
      await api("reorder", { ids });
    };
    card.append(
      thumb,
      name,
      meta,
      button("↑", () => move(-1)),
      button("↓", () => move(1)),
      button("名称変更", () => {
        const name = prompt("画像の名称", img.name);
        if (name) return api("images/" + img.id, { name }, "PATCH");
      }),
      button("削除", () => {
        if (confirm(img.name + " を削除しますか？"))
          return api("images/" + img.id, undefined, "DELETE");
      }),
    );
    library.append(card);
  });
  $("receivers").replaceChildren();
  for (const p of state.receivers) {
    const row = document.createElement("div");
    row.className = "peer";
    row.textContent = `${p.connected ? "● 接続中" : "○ 切断"} ${p.address} / ${p.id.slice(0, 8)} ｜ 最終応答 ${new Date(p.lastSeen).toLocaleTimeString("ja-JP")} ｜ 画像ID ${p.imageId || (p.outputMode === "clear" ? "CLEAR（透明）" : p.outputMode === "black" ? "BLACK" : "未確認")} ｜ SEQ ${p.seq}${p.error ? " ｜ エラー: " + p.error : ""}`;
    $("receivers").append(row);
  }
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
for (const key of ["fit", "background", "fadeMs", "take"]) {
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
$("copyOutputUrl").onclick = async () => {
  $("copyStatus").textContent = "";
  try {
    await copyText(outputUrl);
    $("copyStatus").textContent = "コピーしました";
  } catch (error) {
    $("copyStatus").textContent = "コピーできませんでした";
    report(`${error.message}。URL: ${outputUrl}`);
  }
};
