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
      }),
      receiver = await browser.newContext();
    const page = await admin.newPage(),
      output = await receiver.newPage(),
      other = await receiver.newPage();
    const errors = [];
    for (const p of [page, output, other])
      p.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
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
    await page.locator("#background").fill("#ffffff");
    await page.locator("#saveSettings").click();
    await page.waitForFunction(
      () => document.querySelector("#background").value === "#ffffff",
    );
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
    assert.equal(await output.locator("button, input, select").count(), 0);
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
