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
  "カード全体で選択・操作ボタンの分離・名称変更とEscキャンセル・保存復元",
  { skip: !process.env.CHROMIUM_PATH },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-actions-"));
    const runtime = createApp({ dir, password: "actions-test" });
    const png = await sharp({
      create: { width: 160, height: 90, channels: 4, background: "#00ff0080" },
    })
      .png()
      .toBuffer();
    const images = ["初期画像.png", "変更対象.png", "末尾.png"].map((name) => {
      const img = {
        id: randomUUID(),
        name,
        width: 160,
        height: 90,
        size: png.length,
        mime: "image/png",
      };
      fs.writeFileSync(path.join(dir, "images", img.id), png);
      return img;
    });
    Object.assign(runtime.store.state, {
      images,
      preview: images[0].id,
      program: images[0].id,
      outputMode: "image",
      seq: 1,
    });
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
      httpCredentials: { username: "admin", password: "actions-test" },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base);
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 3,
    );
    const card = (id) => page.locator(`[data-image-id="${id}"]`);
    const previews = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith("/api/command") &&
        request.method() === "POST"
      ) {
        const body = request.postDataJSON();
        if (body.action === "preview") previews.push(body.id);
      }
    });
    for (const target of ["frame", "name", "meta", "number", "thumb"]) {
      const before = previews.length;
      if (target === "frame")
        await card(images[1].id).click({ position: { x: 4, y: 40 } });
      else if (target === "number")
        await card(images[1].id)
          .locator(".card-preview")
          .click({ position: { x: 10, y: 10 } });
      else
        await card(images[1].id)
          .locator("." + target)
          .click();
      await page.waitForFunction(
        () =>
          document.querySelector("#previewName").textContent === "変更対象.png",
      );
      assert.equal(previews.length, before + 1);
    }
    // Restore selection so buttons on another image must leave PREVIEW unchanged.
    await card(images[0].id).locator(".name").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#previewName").textContent === "初期画像.png",
    );
    const baseline = previews.length;
    await card(images[1].id)
      .getByRole("button", { name: "名称変更", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#renameDialog").open,
    );
    assert.equal(
      await page.locator("#renameName").inputValue(),
      "変更対象.png",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector("#renameDialog").open,
    );
    assert.equal(runtime.store.state.program, images[0].id);
    assert.equal(runtime.store.state.seq, 1);
    assert.equal(runtime.store.state.preview, images[0].id);
    assert.equal(previews.length, baseline);
    await card(images[1].id)
      .getByRole("button", { name: "名称変更", exact: true })
      .click();
    await page.locator("#renameName").fill("   ");
    await page.locator("#renameSave").click();
    assert.equal(
      await page.locator("#renameError").textContent(),
      "名称を入力してください",
    );
    const renamed = "新しい画像名_日本語.png";
    await page.locator("#renameName").fill(renamed);
    await page.locator("#renameName").press("Enter");
    await page.waitForFunction(
      () => !document.querySelector("#renameDialog").open,
    );
    assert.equal(
      await card(images[1].id).locator(".name").textContent(),
      renamed,
    );
    assert.equal(runtime.store.state.preview, images[0].id);
    assert.equal(runtime.store.state.seq, 1);
    assert.equal(previews.length, baseline);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dir, "state.json"), "utf8"),
    );
    assert.equal(
      persisted.images.find((img) => img.id === images[1].id).name,
      renamed,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(dir, "images", images[1].id)),
      png,
    );
    await card(images[1].id)
      .getByRole("button", { name: "↓", exact: true })
      .click();
    await page.waitForFunction(
      (id) => document.querySelector(".card:last-child").dataset.imageId === id,
      images[1].id,
    );
    assert.equal(previews.length, baseline);
    assert.equal(runtime.store.state.preview, images[0].id);
    page.once("dialog", (dialog) => dialog.accept());
    await card(images[2].id)
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 2,
    );
    assert.equal(previews.length, baseline);
    assert.equal(runtime.store.state.preview, images[0].id);
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 2,
    );
    assert.equal(
      await card(images[1].id).locator(".name").textContent(),
      renamed,
    );
    await card(images[1].id).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (name) => document.querySelector("#previewName").textContent === name,
      renamed,
    );
    assert.equal(runtime.store.state.program, images[0].id);
    assert.equal(runtime.store.state.seq, 1);
  },
);
