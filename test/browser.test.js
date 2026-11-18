import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { createApp } from "../src/server.js";
test(
  "ブラウザ：登録・PREVIEW・複数受信・FADE・BLACK・再接続・古いSEQ拒否",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-browser-"));
    const runtime = createApp({ dir, password: "browser-test" });
    await new Promise((r) => runtime.server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + runtime.server.address().port;
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox"],
    });
    t.after(async () => {
      await browser.close();
      for (const ws of runtime.wss.clients) ws.terminate();
      await new Promise((r) => runtime.server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const admin = await browser.newContext({
        httpCredentials: { username: "admin", password: "browser-test" },
        permissions: ["clipboard-read", "clipboard-write"],
      }),
      receiver = await browser.newContext();
    const page = await admin.newPage(),
      output = await receiver.newPage(),
      other = await receiver.newPage();
    const errors = [];
    for (const p of [page, output, other])
      p.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(
      () => !document.querySelector("#copyOutputUrl").disabled,
    );
    assert.equal(await page.locator("header a").count(), 0);
    assert.equal(await page.locator("header button").count(), 1);
    const urlResponse = await fetch(base + "/api/output-url", {
      headers: {
        Authorization:
          "Basic " + Buffer.from("admin:browser-test").toString("base64"),
      },
    });
    const expectedUrl = (await urlResponse.json()).url;
    const beforePages = admin.pages().length;
    await page.locator("#copyOutputUrl").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#copyStatus").textContent === "コピーしました",
    );
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      expectedUrl,
    );
    assert.equal(admin.pages().length, beforePages);
    assert.equal(page.url(), base + "/");
    const copyButtonGeometry = await page
      .locator("#copyOutputUrl")
      .boundingBox();
    await page.waitForFunction(
      () => document.querySelector("#copyStatus").textContent === "",
      null,
      { timeout: 2500 },
    );
    assert.deepEqual(
      await page.locator("#copyOutputUrl").boundingBox(),
      copyButtonGeometry,
    );
    // LAN HTTP has no Clipboard API. Exercise its actual native copy fallback.
    await page.evaluate(() => {
      window.nativeClipboard = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      document.addEventListener("copy", () => {
        window.fallbackCopyEvent = true;
      });
      document.querySelector("#copyStatus").textContent = "";
    });
    await page.locator("#copyOutputUrl").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#copyStatus").textContent === "コピーしました",
    );
    assert.equal(await page.evaluate(() => window.fallbackCopyEvent), true);
    assert.equal(
      await page.evaluate(() => window.nativeClipboard.readText()),
      expectedUrl,
    );
    // If both browser copy methods fail, show the URL without opening a tab.
    await page.evaluate(() => {
      window.nativeCopy = document.execCommand;
      document.execCommand = () => false;
    });
    await page.locator("#copyOutputUrl").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#copyStatus").textContent ===
        "コピーできませんでした",
    );
    assert.match(
      await page.locator("#error").textContent(),
      /receiver\?transparent=1/,
    );
    // The preceding success timer must not erase a later failure message.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      await page.locator("#copyStatus").textContent(),
      "コピーできませんでした",
    );
    assert.equal(admin.pages().length, beforePages);
    await page.evaluate(() => {
      document.execCommand = window.nativeCopy;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: window.nativeClipboard,
      });
      document.querySelector("#error").textContent = "";
    });
    await output.goto(base + "/receiver");
    await other.goto(base + "/receiver");
    await page.waitForFunction(
      () => document.querySelector("#receiverCount").textContent === "2台",
    );
    const buffer = await sharp({
      create: { width: 320, height: 180, channels: 4, background: "#0088ff80" },
    })
      .png()
      .toBuffer();
    await page
      .locator("#upload")
      .setInputFiles({ name: "透過テスト.png", mimeType: "image/png", buffer });
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 1,
    );
    assert.match(
      await page.locator("#previewName").textContent(),
      /透過テスト/,
    );
    await page.locator('[data-command="cut"]').click();
    await output.waitForFunction(
      () => document.querySelectorAll("#output img").length === 1,
    );
    await other.waitForFunction(
      () => document.querySelectorAll("#output img").length === 1,
    );
    assert.equal(runtime.store.state.program, runtime.store.state.images[0].id);
    // Operator monitors show checkerboard through alpha, independent of OUT's matte.
    const monitorPixels = async (id) => {
      const { data, info } = await sharp(
        await page.locator("#" + id).screenshot(),
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return [6, 18].map((x) =>
        Array.from(
          data.subarray((6 * info.width + x) * 4, (6 * info.width + x) * 4 + 4),
        ),
      );
    };
    const previewPattern = await monitorPixels("preview"),
      programPattern = await monitorPixels("program");
    assert.notDeepEqual(previewPattern[0], previewPattern[1]);
    assert.notDeepEqual(programPattern[0], programPattern[1]);
    assert.equal(previewPattern[0][3], 255);
    assert.equal(programPattern[0][3], 255);

    await page.locator("#background").fill("#ffffff");
    await page.locator("#saveSettings").click();
    await page.waitForFunction(
      () => document.querySelector("#background").value === "#ffffff",
    );
    assert.deepEqual(await monitorPixels("preview"), previewPattern);
    assert.deepEqual(await monitorPixels("program"), programPattern);
    await page.locator('[data-command="fade"]').click();
    await output.waitForFunction(
      () => document.querySelectorAll("#output img").length === 1,
    );
    await page.waitForFunction(
      () => document.querySelector("#error").textContent === "",
    );
    await page.locator('[data-command="black"]').click();
    await output.waitForFunction(
      () =>
        document.querySelectorAll("#output img").length === 0 &&
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
          "rgb(0, 0, 0)",
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#programName").textContent === "BLACK" &&
        !document
          .querySelector("#program")
          .classList.contains("monitor-transparent"),
    );
    assert.deepEqual((await monitorPixels("program"))[0], [0, 0, 0, 255]);
    await page.locator('[data-command="cut"]').click();
    await output.waitForFunction(
      () => document.querySelectorAll("#output img").length === 1,
    );
    // Terminate sockets to exercise reconnect and PROGRAM restoration.
    for (const ws of runtime.wss.clients) ws.terminate();
    await page.waitForFunction(
      () => document.querySelector("#receiverCount").textContent === "2台",
    );
    await output.reload();
    await output.waitForFunction(
      () => document.querySelectorAll("#output img").length === 1,
    );
    assert.equal(
      await output
        .locator("button:visible, input:visible, select:visible")
        .count(),
      0,
    );
    const seq = await output.evaluate(async () => {
      const { Player } = await import("/assets/player.js");
      const div = document.createElement("div");
      document.body.append(div);
      const p = new Player(div);
      await p.show({ id: null, seq: 9, transition: "cut", duration: 0 });
      await p.show({ id: "stale", seq: 8, transition: "cut", duration: 0 });
      div.remove();
      return p.seq;
    });
    assert.equal(seq, 9);
    assert.deepEqual(errors, []);
  },
);

test(
  "OBS透過OUT：実ピクセルのアルファ、通常OUT、FADE、再読込、BLACKを確認",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-alpha-"));
    const runtime = createApp({ dir, password: "alpha-test" });
    await new Promise((resolve) =>
      runtime.server.listen(0, "127.0.0.1", resolve),
    );
    const base = "http://127.0.0.1:" + runtime.server.address().port;
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ["--no-sandbox"],
    });
    t.after(async () => {
      await browser.close();
      for (const ws of runtime.wss.clients) ws.terminate();
      await new Promise((resolve) => runtime.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const context = await browser.newContext({
      viewport: { width: 640, height: 360 },
    });
    const transparent = await context.newPage(),
      normal = await context.newPage();
    const errors = [];
    for (const page of [transparent, normal])
      page.on("pageerror", (error) => errors.push(error.message));
    await transparent.goto(base + "/receiver?transparent=1");
    await normal.goto(base + "/receiver");
    await transparent.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgb(0, 0, 0)",
    );
    const auth = {
      Authorization:
        "Basic " + Buffer.from("admin:alpha-test").toString("base64"),
    };
    const pixels = Buffer.alloc(64 * 36 * 4);
    for (let y = 0; y < 36; y++)
      for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 3] = x < 20 ? 0 : x < 40 ? 128 : 255;
      }
    const png = await sharp(pixels, {
      raw: { width: 64, height: 36, channels: 4 },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("image", new Blob([png]), "透明・半透明.png");
    const upload = await fetch(base + "/api/images", {
      method: "POST",
      headers: auth,
      body: form,
    });
    assert.equal(upload.status, 201);
    const invoke = async (action) => {
      const res = await fetch(base + "/api/command", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    const inspect = async (page) => {
      const shot = await page.screenshot({ omitBackground: true });
      const { data, info } = await sharp(shot)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return [100, 300, 500].map((x) =>
        Array.from(
          data.subarray(
            (180 * info.width + x) * 4,
            (180 * info.width + x) * 4 + 4,
          ),
        ),
      );
    };
    await invoke("cut");
    for (const page of [transparent, normal])
      await page.waitForFunction(
        () => document.querySelector("#output img")?.complete,
      );
    assert.deepEqual(
      (await inspect(transparent)).map((p) => p[3]),
      [0, 128, 255],
    );
    assert.deepEqual(
      (await inspect(normal)).map((p) => p[3]),
      [255, 255, 255],
    );
    // A global background change must affect only the regular OUT.
    const settings = {
      fit: "contain",
      background: "#ffffff",
      fadeMs: 150,
      take: "fade",
    };
    const changed = await fetch(base + "/api/settings", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    assert.equal(changed.status, 200);
    await normal.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgb(255, 255, 255)",
    );
    assert.deepEqual(
      (await inspect(transparent)).map((p) => p[3]),
      [0, 128, 255],
    );
    // Exercise BLACK -> FADE and a state update during the fade.
    await invoke("black");
    await transparent.waitForFunction(
      () => !document.querySelector("#output img"),
    );
    assert.deepEqual((await inspect(transparent))[0], [0, 0, 0, 255]);
    await invoke("fade");
    await fetch(base + "/api/settings", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    await transparent.waitForFunction(
      () =>
        document.querySelector("#output img") &&
        document.querySelector("#output img").getAnimations().length === 0,
    );
    assert.deepEqual(
      (await inspect(transparent)).map((p) => p[3]),
      [0, 128, 255],
    );
    await transparent.reload();
    await transparent.waitForFunction(
      () => document.querySelector("#output img")?.complete,
    );
    assert.deepEqual(
      (await inspect(transparent)).map((p) => p[3]),
      [0, 128, 255],
    );
    // FIT letterbox areas must also remain transparent.
    await transparent.setViewportSize({ width: 640, height: 480 });
    const letterbox = await transparent.screenshot({ omitBackground: true });
    const corner = await sharp(letterbox)
      .extract({ left: 1, top: 1, width: 1, height: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.equal(corner[3], 0);
    // CLEAR must remove every output pixel, unlike BLACK; restore after reload.
    await invoke("clear");
    await transparent.waitForFunction(
      () =>
        !document.querySelector("#output img") &&
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
          "rgba(0, 0, 0, 0)",
    );
    const assertClear = async () => {
      const frame = await transparent.screenshot({ omitBackground: true });
      const alpha = (await sharp(frame).ensureAlpha().stats()).channels[3];
      assert.equal(alpha.min, 0);
      assert.equal(alpha.max, 0);
    };
    await assertClear();
    assert.deepEqual((await inspect(normal))[0], [0, 0, 0, 255]);
    await transparent.reload();
    await transparent.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgba(0, 0, 0, 0)",
    );
    await assertClear();
    await invoke("black");
    await transparent.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgb(0, 0, 0)",
    );
    assert.equal((await inspect(transparent))[0][3], 255);
    await invoke("fade");
    await invoke("clear");
    await transparent.waitForFunction(
      () =>
        !document.querySelector("#output img") &&
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
          "rgba(0, 0, 0, 0)",
    );
    // Let the interrupted 150ms fade finish; its callback must not undo CLEAR.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assertClear();
    await invoke("cut");
    await transparent.waitForFunction(
      () => document.querySelector("#output img")?.complete,
    );
    assert.deepEqual(
      (await inspect(transparent)).map((p) => p[3]),
      [0, 128, 255],
    );

    assert.deepEqual(errors, []);
  },
);
