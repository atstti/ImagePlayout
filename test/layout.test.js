import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { createApp } from "../src/server.js";

test(
  "左ライブラリ：末尾の選択・状態更新でも両モニターが見え、スクロールを維持",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-layout-"));
    const runtime = createApp({ dir, password: "layout-test" });
    const png = await sharp({
      create: { width: 160, height: 90, channels: 4, background: "#0088ff80" },
    })
      .png()
      .toBuffer();
    runtime.store.state.images = Array.from({ length: 24 }, (_, index) => {
      const img = {
        id: randomUUID(),
        name:
          index < 2
            ? `slide0${index + 1}.png`
            : `画像${index + 1}・日本語の長いファイル名の表示を確認.png`,
        size: png.length,
        width: 160,
        height: 90,
        mime: "image/png",
      };
      fs.writeFileSync(path.join(dir, "images", img.id), png);
      return img;
    });
    runtime.store.state.preview = runtime.store.state.images[0].id;
    runtime.store.state.program = runtime.store.state.images[1].id;
    runtime.store.state.outputMode = "image";
    runtime.store.state.seq = 1;
    runtime.store.save();
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
    const context = await browser.newContext({
      httpCredentials: { username: "admin", password: "layout-test" },
    });
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 24,
    );
    for (const [width, height] of [
      [1366, 768],
      [1024, 768],
      [850, 650],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => {
        document.querySelector("#library").scrollTop = 0;
        document.querySelector(".playout-panel").scrollTop = 0;
      });
      const geometry = () =>
        page.evaluate(() => {
          const rect = (id) => {
            const r = document.querySelector(id).getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          };
          return {
            library: rect(".library-panel"),
            buttons: [
              ...document.querySelectorAll(".controls [data-command]"),
            ].map((el) => rect(`[data-command="${el.dataset.command}"]`)),
            preview: rect("#preview"),
            program: rect("#program"),
            stageScroll: document.querySelector(".playout-panel").scrollTop,
            windowScroll: scrollY,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
      const before = await geometry();
      const cards = await page.locator(".card").evaluateAll((cards) =>
        cards.slice(0, 3).map((card) => {
          const r = card.getBoundingClientRect();
          return { x: r.x, y: r.y, bottom: r.bottom };
        }),
      );
      assert.equal(cards[0].x, cards[1].x);
      assert.equal(cards[1].x, cards[2].x);
      assert.ok(cards[0].bottom <= cards[1].y);
      assert.ok(cards[1].bottom <= cards[2].y);
      assert.equal(
        await page.locator(".card").first().locator(".name").textContent(),
        "slide01.png",
      );
      assert.equal(
        await page
          .locator(".card")
          .first()
          .locator(".card-number")
          .textContent(),
        "No. 01",
      );
      // Latin caption -> Japanese CLEAR -> BLACK -> image must not move any button.
      for (const [action, label] of [
        ["clear", "CLEAR（透明）"],
        ["black", "BLACK"],
        ["cut", "slide01.png"],
      ]) {
        await page.locator(`[data-command="${action}"]`).click();
        await page.waitForFunction(
          (label) =>
            document.querySelector("#programName").textContent === label,
          label,
        );
        assert.deepEqual(await geometry(), before);
      }

      assert.ok(before.library.right <= before.preview.x);
      assert.ok(before.preview.right <= before.program.x);
      assert.ok(before.preview.y >= 0 && before.preview.bottom <= height);
      assert.ok(before.program.y >= 0 && before.program.bottom <= height);
      assert.equal(before.overflow, false);
      await page.locator("#library .thumb").last().click();
      await page.waitForFunction(() =>
        document
          .querySelector("#previewName")
          .textContent.startsWith("画像24・"),
      );
      const after = await geometry();
      assert.deepEqual(after, before);
      const scroll = await page
        .locator("#library")
        .evaluate((el) => el.scrollTop);
      assert.ok(scroll > 0);
      const response = await fetch(base + "/api/command", {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from("admin:layout-test").toString("base64"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "next" }),
      });
      assert.equal(response.status, 200);
      await page.waitForFunction(() =>
        document
          .querySelector("#previewName")
          .textContent.startsWith("slide01.png"),
      );
      assert.equal(
        await page.locator("#library").evaluate((el) => el.scrollTop),
        scroll,
      );
      assert.deepEqual(await geometry(), before);
      if (process.env.LAYOUT_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.LAYOUT_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(
            process.env.LAYOUT_SCREENSHOT_DIR,
            `layout-${width}.png`,
          ),
        });
      }
    }
    // Small browser windows use a stacked layout without horizontal overflow.
    await page.setViewportSize({ width: 600, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  },
);
