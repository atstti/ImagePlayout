import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { WebSocket } from "ws";
import { createApp } from "../src/server.js";
const auth = "Basic " + Buffer.from("admin:test-password").toString("base64");
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-"));
  const runtime = createApp({ dir, password: "test-password" });
  await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + runtime.server.address().port;
  t.after(async () => {
    for (const ws of runtime.wss.clients) ws.terminate();
    await new Promise((r) => runtime.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    ...runtime,
    dir,
    base,
    api: async (url, body, method = "POST") =>
      fetch(base + "/api/" + url, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}
async function image(f) {
  const data = await sharp({
    create: { width: 32, height: 18, channels: 4, background: "#ff000080" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([data]), "テスト画像.png");
  const res = await fetch(f.base + "/api/images", {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
  });
  assert.equal(res.status, 201);
  return res.json();
}
function messages(ws) {
  const queue = [],
    waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const at = waiters.findIndex((w) => w.type === m.type);
    if (at >= 0) {
      const [w] = waiters.splice(at, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else queue.push(m);
  });
  return (type) => {
    const at = queue.findIndex((m) => m.type === type);
    if (at >= 0) return Promise.resolve(queue.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("WS timeout: " + type)),
        3000,
      );
      waiters.push({ type, resolve, timer });
    });
  };
}
test("認証・日本語アップロード・検証・送出・再起動復元", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/api/state")).status, 401);
  assert.equal((await fetch(f.base + "/")).status, 401);
  assert.equal((await fetch(f.base + "/receiver")).status, 200);
  const img = await image(f);
  assert.equal(img.name, "テスト画像.png");
  assert.equal(img.width, 32);
  assert.equal(img.height, 18);
  assert.equal(
    (await fetch(f.base + "/media/" + img.id)).headers.get("content-type"),
    "image/png",
  );
  const bad = new FormData();
  bad.append("image", new Blob(["<svg></svg>"]), "bad.png");
  assert.equal(
    (
      await fetch(f.base + "/api/images", {
        method: "POST",
        headers: { Authorization: auth },
        body: bad,
      })
    ).status,
    400,
  );
  assert.equal((await f.api("command", { action: "cut" })).status, 200);
  assert.equal(
    (await f.api("images/" + img.id, undefined, "DELETE")).status,
    409,
  );
  const restored = createApp({ dir: f.dir, password: "test-password" });
  assert.equal(restored.store.state.program, img.id);
  assert.equal(restored.store.state.seq, 1);
  restored.wss.close();
  assert.equal((await f.api("command", { action: "black" })).status, 200);
  assert.equal(
    (await f.api("images/" + img.id, undefined, "DELETE")).status,
    204,
  );
});
test("権限とOrigin、設定、並べ替え入力検証", async (t) => {
  const f = await fixture(t);
  const img = await image(f);
  assert.equal((await f.api("reorder", { ids: [img.id, img.id] })).status, 400);
  assert.equal(
    (
      await f.api("settings", {
        fit: "evil",
        background: "red",
        fadeMs: -1,
        take: "cut",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/state", {
        headers: { Authorization: auth, Origin: "http://evil.example" },
      })
    ).status,
    403,
  );
  await new Promise((resolve) => {
    const ws = new WebSocket(f.base.replace("http", "ws") + "/ws?role=admin");
    ws.on("unexpected-response", (req, res) => {
      assert.equal(res.statusCode, 403);
      res.resume();
      resolve();
    });
  });
});
test("全受信PCのpreload ACK後のみ送出し、受信PCからの命令は無視する", async (t) => {
  const f = await fixture(t),
    img = await image(f);
  const ws = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver");
  const next = messages(ws);
  await next("state");
  ws.send(JSON.stringify({ type: "command", action: "black" }));
  const take = f.api("command", { action: "fade" });
  const prepare = await next("prepare");
  assert.equal(f.store.state.program, null);
  ws.send(
    JSON.stringify({ type: "ack", id: img.id, token: "wrong", ok: true }),
  );
  assert.equal(f.store.state.seq, 0);
  ws.send(
    JSON.stringify({ type: "ack", id: img.id, token: prepare.token, ok: true }),
  );
  assert.equal((await take).status, 200);
  const program = await next("program");
  assert.equal(program.id, img.id);
  assert.equal(program.transition, "fade");
  assert.equal(program.seq, 1);
  ws.close();
});
test("読み込み失敗では送出しない・緊急BLACKが待機を中断", async (t) => {
  const f = await fixture(t),
    img = await image(f);
  const ws = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver"),
    next = messages(ws);
  await next("state");
  let take = f.api("command", { action: "cut" }),
    prepare = await next("prepare");
  ws.send(
    JSON.stringify({
      type: "ack",
      id: img.id,
      token: prepare.token,
      ok: false,
    }),
  );
  assert.equal((await take).status, 409);
  assert.equal(f.store.state.seq, 0);
  take = f.api("command", { action: "take" });
  await next("prepare");
  assert.equal((await f.api("command", { action: "black" })).status, 200);
  assert.equal((await take).status, 409);
  assert.equal(f.store.state.program, null);
  assert.equal(f.store.state.seq, 1);
  ws.close();
});
test("2台のACKを待ち、切断時は送出を中止し再接続時に状態を配信", async (t) => {
  const f = await fixture(t),
    img = await image(f);
  const a = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver"),
    b = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver");
  const an = messages(a),
    bn = messages(b);
  await an("state");
  await bn("state");
  const take = f.api("command", { action: "cut" });
  const ap = await an("prepare");
  await bn("prepare");
  a.send(
    JSON.stringify({ type: "ack", id: img.id, token: ap.token, ok: true }),
  );
  b.close();
  assert.equal((await take).status, 409);
  assert.equal(f.store.state.program, null);
  a.close();
  const c = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver"),
    cn = messages(c);
  const state = await cn("state");
  assert.equal(state.program, null);
  assert.equal(state.seq, 0);
  c.close();
});

test("CLEAR：送出待機を中断・状態を永続化・再接続へ復元しBLACKと区別", async (t) => {
  const f = await fixture(t);
  await image(f);
  const ws = new WebSocket(f.base.replace("http", "ws") + "/ws?role=receiver");
  const next = messages(ws);
  await next("state");
  const take = f.api("command", { action: "take" });
  const prepare = await next("prepare");
  assert.equal((await f.api("command", { action: "clear" })).status, 200);
  assert.equal((await take).status, 409);
  const clear = await next("program");
  assert.equal(clear.id, null);
  assert.equal(clear.outputMode, "clear");
  assert.equal(clear.seq, 1);
  ws.send(
    JSON.stringify({
      type: "ack",
      id: prepare.id,
      token: prepare.token,
      ok: true,
    }),
  );
  assert.equal(f.store.state.outputMode, "clear");
  const restored = createApp({ dir: f.dir, password: "test-password" });
  assert.equal(restored.store.state.outputMode, "clear");
  assert.equal(restored.store.state.program, null);
  restored.wss.close();
  const receiver = new WebSocket(
    f.base.replace("http", "ws") + "/ws?role=receiver",
  );
  const restoredMessages = messages(receiver);
  assert.equal((await restoredMessages("state")).outputMode, "clear");
  assert.equal((await f.api("command", { action: "black" })).status, 200);
  assert.equal((await next("program")).outputMode, "black");
  assert.equal((await f.api("command", { action: "clear" })).status, 200);
  const pending = f.api("command", { action: "cut" });
  const a = await next("prepare"),
    b = await restoredMessages("prepare");
  ws.send(JSON.stringify({ type: "ack", id: a.id, token: a.token, ok: true }));
  receiver.send(
    JSON.stringify({ type: "ack", id: b.id, token: b.token, ok: true }),
  );
  assert.equal((await pending).status, 200);
  assert.equal(f.store.state.outputMode, "image");
  ws.close();
  receiver.close();
});

test("旧状態ファイルのnull PROGRAMはBLACKとして読み込み互換性を維持", async (t) => {
  const f = await fixture(t);
  const legacy = { ...f.store.state };
  delete legacy.outputMode;
  fs.writeFileSync(path.join(f.dir, "state.json"), JSON.stringify(legacy));
  const restored = createApp({ dir: f.dir, password: "test-password" });
  assert.equal(restored.store.state.outputMode, "black");
  restored.wss.close();
});

test("透過OUTコピー用URL APIは認証を要求し、資格情報を含まないURLを返す", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/api/output-url")).status, 401);
  const response = await f.api("output-url", undefined, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const url = new URL((await response.json()).url);
  assert.equal(url.pathname, "/receiver");
  assert.equal(url.searchParams.get("transparent"), "1");
  assert.equal(url.port, new URL(f.base).port);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
});

test("PREVIEW CLEAR：準備はPROGRAM不変・TAKEのFADE/CUT・保存復元・NEXT", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api("command", { action: "take" })).status, 400);
  const img = await image(f);
  await f.api("command", { action: "cut" });
  const seq = f.store.state.seq;
  assert.equal((await f.api("command", { action: "preview-clear" })).status, 200);
  assert.equal(f.store.state.program, img.id);
  assert.equal(f.store.state.seq, seq);
  assert.equal(f.store.state.preview, null);
  assert.equal(f.store.state.previewMode, "clear");
  const restored = createApp({ dir: f.dir, password: "test-password" });
  assert.equal(restored.store.state.previewMode, "clear");
  restored.wss.close();
  await image(f); // Registering another file must not replace prepared CLEAR.
  assert.equal(f.store.state.previewMode, "clear");
  assert.equal((await f.api("command", { action: "take" })).status, 200);
  assert.equal(f.store.state.outputMode, "clear");
  assert.equal(f.store.state.seq, seq + 1);
  await f.api("command", { action: "next" });
  assert.equal(f.store.state.previewMode, "image");
  assert.equal(f.store.state.preview, img.id);
  await f.api("command", { action: "preview-clear" });
  await f.api("command", { action: "black" });
  await f.api("settings", { ...f.store.state.settings, take: "cut" });
  assert.equal((await f.api("command", { action: "take" })).status, 200);
  assert.equal(f.store.state.outputMode, "clear");
});
