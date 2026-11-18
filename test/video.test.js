import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createApp } from "../src/server.js";
import { formatTime, formatRemaining } from "../public/time.js";
import { Store } from "../src/store.js";
const fixturePath = (name) => new URL("./fixtures/" + name, import.meta.url);
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-video-"));
  const runtime = createApp({ dir, password: "video-test" });
  await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + runtime.server.address().port;
  t.after(async () => {
    for (const ws of runtime.wss.clients) ws.terminate();
    await new Promise((r) => runtime.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const headers = {
    Authorization:
      "Basic " + Buffer.from("admin:video-test").toString("base64"),
  };
  const api = async (url, body) =>
    fetch(base + "/api/" + url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const upload = async (name, data = fs.readFileSync(fixturePath(name))) => {
    const form = new FormData();
    form.append("image", new Blob([data]), name);
    return fetch(base + "/api/images", { method: "POST", headers, body: form });
  };
  return { ...runtime, dir, base, headers, api, upload };
}

test("動画ループ：初期OFF・保存済みON/OFFを維持・旧データもOFF", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-loop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  assert.equal(store.state.settings.videoLoop, false);
  assert.equal(store.state.settings.videoMuted, false);
  for (const enabled of [true, false]) {
    store.state.settings.videoLoop = enabled;
    store.save();
    assert.equal(new Store(dir).state.settings.videoLoop, enabled);
  }
  delete store.state.settings.videoLoop;
  store.save();
  assert.equal(new Store(dir).state.settings.videoLoop, false);
});

test("動画登録：MP4/WebM・音声/時間メタデータ・Range・偽装拒否・保存復元", async (t) => {
  const f = await setup(t);
  for (const name of ["sample.mp4", "sample.webm"]) {
    const response = await f.upload(name);
    assert.equal(response.status, 201, await response.clone().text());
    const media = await response.json();
    assert.equal(media.kind, "video");
    assert.equal(media.width, 160);
    assert.equal(media.height, 90);
    assert.ok(media.duration >= 4 && media.duration < 4.1);
    assert.equal(media.hasAudio, true);
    const bytes = fs.readFileSync(fixturePath(name));
    const partial = await fetch(f.base + "/media/" + media.id, {
      headers: { Range: "bytes=0-31" },
    });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get("content-range"),
      `bytes 0-31/${bytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      bytes.subarray(0, 32),
    );
  }
  const invalid = await f.upload(
    "fake.mp4",
    Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex"),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "uploads")), []);
  assert.equal((await f.api("command", { action: "cut" })).status, 200);
  assert.ok(f.store.state.programStartedAt > 0);
  const restored = createApp({ dir: f.dir, password: "video-test" });
  assert.equal(restored.store.state.program, f.store.state.program);
  assert.equal(
    restored.store.state.programStartedAt,
    f.store.state.programStartedAt,
  );
  assert.equal(restored.store.state.settings.videoMuted, false);
  restored.wss.close();
});

test("動画上限：初期2GB・認証・変更・検証・旧クライアント・再起動復元", async (t) => {
  const f = await setup(t);
  const settings = { ...f.store.state.settings };
  assert.equal(settings.maxVideoUploadMB, 2048);
  const denied = await fetch(f.base + "/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...settings, maxVideoUploadMB: 1 }),
  });
  assert.equal(denied.status, 401);
  for (const invalid of [0, -1, 1.5, 65537, "2048"]) {
    assert.equal((await f.api("settings", { ...settings, maxVideoUploadMB: invalid })).status, 400);
    assert.equal(f.store.state.settings.maxVideoUploadMB, 2048);
  }
  assert.equal((await f.api("settings", { ...settings, maxVideoUploadMB: 1 })).status, 200);
  const large = Buffer.concat([fs.readFileSync(fixturePath("sample.mp4")), Buffer.alloc(1024 * 1024)]);
  const rejected = await f.upload("large.mp4", large);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /動画は1MB以下/);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "uploads")), []);
  assert.equal((await f.upload("sample.mp4")).status, 201);
  const legacy = { ...settings }; delete legacy.maxVideoUploadMB;
  assert.equal((await f.api("settings", legacy)).status, 200);
  assert.equal(f.store.state.settings.maxVideoUploadMB, 1);
  assert.equal(new Store(f.dir).state.settings.maxVideoUploadMB, 1);
  assert.equal((await f.api("settings", { ...settings, maxVideoUploadMB: 2048 })).status, 200);
  assert.equal(new Store(f.dir).state.settings.maxVideoUploadMB, 2048);
});

test("時間表示：0・分/時またぎ・残り0・未設定", () => {
  assert.equal(formatTime(0), "00:00.0");
  assert.equal(formatTime(4.018), "00:04.0");
  assert.equal(formatTime(65.4), "01:05.4");
  assert.equal(formatTime(3661.2), "01:01:01.2");
  assert.equal(formatTime(NaN), "--:--.-");
  assert.equal(formatRemaining(4, 3.999), "00:00.1");
  assert.equal(formatRemaining(4, 4), "00:00.0");
});

test(
  "動画送出：音声ON・PREVIEW停止・残り時間・ループ・終了・復元・FADE中CLEAR",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const f = await setup(t);
    const clip = await (await f.upload("sample.mp4")).json();
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    t.after(() => browser.close());
    const admin = await browser.newContext({
      httpCredentials: { username: "admin", password: "video-test" },
      viewport: { width: 1366, height: 768 },
    });
    const page = await admin.newPage();
    await page.goto(f.base);
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => document.querySelector("#preview video")?.readyState >= 3);
    assert.equal(await page.locator("#videoLoop").isChecked(), false);
    assert.equal(await page.locator("#maxVideoUploadMB").inputValue(), "2048");
    await page.locator("#maxVideoUploadMB").fill("1024");
    await page.locator("#videoLoop").check();
    await page.locator("#saveSettings").click();
    await page.waitForFunction(() => document.querySelector("#uploadLimit").textContent === "動画1024MBまで");
    const receiver = await browser.newPage();
    await receiver.goto(f.base + "/receiver?transparent=1");
    receiver.setDefaultTimeout(15000);
    await page.waitForFunction(
      () => document.querySelector("#preview video")?.readyState >= 3,
    );
    assert.equal(
      await page
        .locator("#preview video")
        .evaluate((v) => v.paused && v.muted && v.currentTime === 0),
      true,
    );
    assert.equal(
      await page.locator("#previewDuration").textContent(),
      "00:04.0",
    );
    assert.match(
      await page.locator(".card .meta").textContent(),
      /VIDEO.*00:04.0/,
    );
    await page.locator('[data-command="cut"]').click();
    await receiver.waitForFunction(
      () => document.querySelector("#output video")?.currentTime > 0.3,
    );
    assert.equal(
      await receiver
        .locator("#output video")
        .evaluate((v) => !v.paused && !v.muted && v.loop),
      true,
    );
    assert.equal(
      await page.locator("#program video").evaluate((v) => v.muted),
      true,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#programRemaining").textContent !== "--:--.-",
    );
    assert.equal(
      await page.locator("#remainingLabel").textContent(),
      "次のループまで",
    );
    await page.locator("#videoAudio").uncheck();
    await page.locator("#saveSettings").click();
    await receiver.waitForFunction(
      () => document.querySelector("#output video").muted === true,
    );
    await page.locator("#videoAudio").check();
    await page.locator("#saveSettings").click();
    await receiver.waitForFunction(
      () => document.querySelector("#output video").muted === false,
    );
    await page.locator("#monitorAudio").check();
    assert.equal(
      await page.locator("#program video").evaluate((v) => v.muted),
      false,
    );
    await page.locator("#monitorAudio").uncheck();
    assert.equal(
      await page.locator("#program video").evaluate((v) => v.muted),
      true,
    );
    const first = await page.locator("#programRemaining").textContent();
    await page.waitForFunction(
      (first) =>
        document.querySelector("#programRemaining").textContent !== first,
      first,
    );
    assert.equal(f.store.state.program, clip.id);
    if (process.env.VIDEO_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.VIDEO_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.VIDEO_SCREENSHOT_DIR, "video-playout.png"),
      });
    }
    const elapsed = await receiver
      .locator("#output video")
      .evaluate((v) => v.currentTime);
    await receiver.reload();
    await receiver.waitForFunction(
      () => document.querySelector("#output video")?.currentTime > 0.1,
    );
    const resumed = await receiver
      .locator("#output video")
      .evaluate((v) => v.currentTime);
    assert.ok(resumed >= elapsed - 0.25);
    // Without looping the final frame is retained and remaining time reaches zero.
    await page.locator("#videoLoop").uncheck();
    await page.locator("#saveSettings").click();
    await page.waitForFunction(
      () => document.querySelector("#program video")?.loop === false,
    );
    await page.locator('[data-command="cut"]').click();
    await receiver.waitForFunction(
      () => document.querySelector("#output video")?.ended,
      {},
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#programRemaining").textContent === "00:00.0",
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#programPlaybackState").textContent ===
        "再生完了",
    );
    assert.equal(
      await page.locator("#programPlaybackState").textContent(),
      "再生完了",
    );
    await page.locator("#videoLoop").check();
    await page.locator("#saveSettings").click();
    await page.locator('[data-command="cut"]').click();
    await receiver.waitForFunction(
      () =>
        document.querySelector("#output video") &&
        !document.querySelector("#output video").paused,
    );
    const second = await f.upload("sample.webm");
    assert.equal(second.status, 201);
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 2,
    );
    await page.locator(".card").last().locator(".name").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#previewName").textContent === "sample.webm" &&
        document.querySelector("#preview video")?.readyState >= 3,
    );
    await receiver.evaluate(() => {
      window.outgoing = document.querySelector("#output video");
    });
    await page.locator('[data-command="fade"]').click();
    await receiver.waitForFunction(
      () => document.querySelectorAll("#output video").length === 2,
    );
    await receiver.evaluate(() => {
      window.lastVideo = document.querySelector("#output video:last-child");
    });
    await page.locator('[data-command="clear"]').click();
    await receiver.waitForFunction(
      () => !document.querySelector("#output video"),
    );
    assert.equal(await receiver.evaluate(() => window.lastVideo.paused), true);
    assert.equal(await receiver.evaluate(() => window.outgoing.paused), true);
    await page.waitForFunction(
      () =>
        document.querySelector("#programRemaining").textContent === "--:--.-",
    );
    assert.equal(await receiver.locator("#audioUnlock").isVisible(), false);
  },
);

test(
  "音声の自動再生制限：許可ボタンから再生しBLACKで音声も停止",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const f = await setup(t);
    await f.upload("sample.webm");
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox", "--autoplay-policy=user-gesture-required"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    // Automation evaluation can transiently activate a document. Require an
    // actual trusted click on the permission button, not a timing-dependent
    // navigator.userActivation check, before delegating to native play().
    await page.addInitScript(() => {
      let audioAllowed = false;
      document.addEventListener(
        "click",
        (event) => {
          if (event.isTrusted && event.target.closest("#audioUnlock"))
            audioAllowed = true;
        },
        true,
      );
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!this.muted && !audioAllowed)
          return Promise.reject(
            new DOMException(
              "Audio requires a user gesture",
              "NotAllowedError",
            ),
          );
        return play.call(this);
      };
    });
    await page.goto(f.base + "/receiver?transparent=1");
    assert.equal((await f.api("command", { action: "cut" })).status, 200);
    await page.locator("#audioUnlock").waitFor({ state: "visible" });
    await page.locator("#audioUnlock").click();
    await page.waitForFunction(
      () => document.querySelector("#output video")?.currentTime > 0.2,
    );
    assert.equal(
      await page
        .locator("#output video")
        .evaluate((v) => !v.paused && !v.muted),
      true,
    );
    assert.equal(await page.locator("#audioUnlock").isVisible(), false);
    await page.evaluate(() => {
      window.lastVideo = document.querySelector("#output video");
    });
    assert.equal((await f.api("command", { action: "black" })).status, 200);
    await page.waitForFunction(() => !document.querySelector("#output video"));
    assert.equal(await page.evaluate(() => window.lastVideo.paused), true);
  },
);
