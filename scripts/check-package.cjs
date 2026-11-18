// Smoke-test the actual packaged Electron app, including its bundled sharp binary.
const { _electron: electron } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");
const sharp = require("sharp");

async function alphaRange(frame) {
  // PNG encoders may omit the alpha channel for an opaque BLACK frame.
  const { data, info } = await sharp(frame)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let min = 255,
    max = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    min = Math.min(min, data[index]);
    max = Math.max(max, data[index]);
  }
  return { min, max };
}

async function main() {
  const [platform, arch] = process.argv.slice(2);
  const executable =
    platform === "mac"
      ? path.join(
          "dist",
          arch === "arm64" ? "mac-arm64" : "mac",
          "Image Playout LAN.app",
          "Contents",
          "MacOS",
          "Image Playout LAN",
        )
      : platform === "win"
        ? path.join("dist", "win-unpacked", "Image Playout LAN.exe")
        : path.join("dist", "linux-unpacked", "image-playout-lan");
  assert.ok(
    fs.existsSync(executable),
    `Packaged executable missing: ${executable}`,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playout-packaged-"));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const application = await electron.launch({
    executablePath: path.resolve(executable),
    args:
      process.platform === "linux"
        ? ["--no-sandbox", "--ozone-platform=headless", "--disable-gpu"]
        : [],
    env: { ...process.env, PORT: String(port), IMAGE_PLAYOUT_USER_DATA: dir },
    timeout: 60000,
  });
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(30000);
    await page.waitForFunction(
      () => !document.querySelector("#copyOutputUrl").disabled,
    );
    const windowCount = application.windows().length;
    await page.locator("#copyOutputUrl").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#copyStatus").textContent === "コピーしました",
    );
    const copiedUrl = new URL(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
    );
    assert.equal(copiedUrl.pathname, "/receiver");
    assert.equal(copiedUrl.searchParams.get("transparent"), "1");
    assert.equal(copiedUrl.port, String(port));
    assert.equal(copiedUrl.username, "");
    assert.equal(copiedUrl.password, "");
    assert.equal(application.windows().length, windowCount);
    await page.waitForFunction(
      () => document.querySelector("#copyStatus").textContent === "",
      null,
      { timeout: 2500 },
    );
    const libraryBox = await page.locator(".library-panel").boundingBox();
    const previewBox = await page.locator("#preview").boundingBox();
    const programBox = await page.locator("#program").boundingBox();
    assert.ok(libraryBox.x + libraryBox.width <= previewBox.x);
    assert.ok(previewBox.x + previewBox.width <= programBox.x);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector("#upload", {
      timeout: 30000,
      state: "attached",
    });
    const png = await sharp({
      create: { width: 64, height: 36, channels: 4, background: "#ff000080" },
    })
      .png()
      .toBuffer();
    await page.locator("#upload").setInputFiles({
      name: "配布版テスト.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 1,
    );
    await page.locator('[data-command="cut"]').click();
    await page.waitForFunction(
      () => document.querySelector("#program img")?.complete,
    );
    assert.match(
      await page.locator("#programName").textContent(),
      /配布版テスト/,
    );
    for (const id of ["preview", "program"]) {
      const monitor = page.locator("#" + id);
      const box = await monitor.boundingBox();
      const { data, info } = await sharp(await monitor.screenshot())
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixel = (x) => {
        const offset =
          (Math.floor((6 * info.height) / box.height) * info.width +
            Math.floor((x * info.width) / box.width)) *
          4;
        return Array.from(data.subarray(offset, offset + 4));
      };
      assert.notDeepEqual(
        pixel(6),
        pixel(18),
        id + " should reveal checkerboard through PNG alpha",
      );
    }
    const receiver = await fetch(`http://127.0.0.1:${port}/receiver`);
    assert.equal(receiver.status, 200);
    assert.ok(fs.existsSync(path.join(dir, "data", "admin-password.txt")));
    assert.deepEqual(errors, []);
    // Verify real alpha pixels from the frontend bundled in this app.
    const outputPromise = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }, url) => {
      const receiver = new BrowserWindow({
        width: 640,
        height: 360,
        useContentSize: true,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      receiver.loadURL(url);
    }, `http://127.0.0.1:${port}/receiver?transparent=1`);
    const output = await outputPromise;
    output.setDefaultTimeout(30000);
    await output.waitForFunction(
      () => document.querySelector("#output img")?.complete,
    );
    const screenshot = await output.screenshot({ omitBackground: true });
    const dimensions = await sharp(screenshot).metadata();
    const alpha = await sharp(screenshot)
      .extract({
        left: Math.floor(dimensions.width / 2),
        top: Math.floor(dimensions.height / 2),
        width: 1,
        height: 1,
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.ok(
      Math.abs(alpha[3] - 128) <= 1,
      `Packaged transparent OUT alpha was ${alpha[3]}`,
    );
    assert.equal(
      await page.locator(".card .name").textContent(),
      "配布版テスト.png",
    );
    assert.equal(await page.locator(".card-number").textContent(), "No. 01");
    await page.getByRole("button", { name: "名称変更", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("#renameDialog").open,
    );
    await page.locator("#renameName").fill("");
    await page.locator("#renameName").fill("配布版・名称変更済み.png");
    await page.locator("#renameSave").click();
    await page.waitForFunction(
      () => !document.querySelector("#renameDialog").open,
    );
    assert.equal(
      await page.locator(".card .name").textContent(),
      "配布版・名称変更済み.png",
    );
    assert.equal(
      await page.locator("#programName").textContent(),
      "配布版・名称変更済み.png",
    );
    const commandGeometry = () =>
      page.locator(".controls [data-command]").evaluateAll((buttons) =>
        buttons.map((button) => {
          const r = button.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
    const beforeClear = await commandGeometry();
    await page.locator('[data-command="clear"]').click();
    await output.waitForFunction(
      () =>
        !document.querySelector("#output img") &&
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
          "rgba(0, 0, 0, 0)",
    );
    assert.deepEqual(await commandGeometry(), beforeClear);
    const cleared = await output.screenshot({ omitBackground: true });
    const clearAlpha = await alphaRange(cleared);
    assert.equal(clearAlpha.min, 0);
    assert.equal(clearAlpha.max, 0);
    assert.equal(
      await page.locator("#programName").textContent(),
      "CLEAR（透明）",
    );
    await output.reload();
    await output.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgba(0, 0, 0, 0)",
    );
    await page.locator('[data-command="black"]').click();
    await output.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#output")).backgroundColor ===
        "rgb(0, 0, 0)",
    );
    const blackAlpha = await alphaRange(
      await output.screenshot({ omitBackground: true }),
    );
    assert.equal(blackAlpha.min, 255);
    assert.equal(blackAlpha.max, 255);
    assert.deepEqual(await commandGeometry(), beforeClear);
    // Upload a real H.264/AAC clip through the packaged WASM validator.
    await page
      .locator("#upload")
      .setInputFiles(path.resolve("test/fixtures/sample.mp4"));
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 2,
    );
    await page.locator(".card").last().locator(".name").click();
    await page.waitForFunction(
      () => document.querySelector("#preview video")?.readyState >= 3,
    );
    assert.equal(
      await page.locator("#preview video").evaluate((v) => v.paused && v.muted),
      true,
    );
    assert.equal(
      await page.locator("#previewDuration").textContent(),
      "00:04.0",
    );
    await page.locator('[data-command="cut"]').click();
    await output.waitForFunction(
      () =>
        document.querySelector("#output video") ||
        !document.querySelector("#audioUnlock").hidden,
    );
    if (await output.locator("#audioUnlock").isVisible())
      await output.locator("#audioUnlock").click();
    await output.waitForFunction(
      () => document.querySelector("#output video")?.currentTime > 0.2,
    );
    assert.equal(
      await output
        .locator("#output video")
        .evaluate((v) => !v.paused && !v.muted),
      true,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#programRemaining").textContent !== "--:--.-",
    );
    await output.evaluate(() => {
      window.outgoing = document.querySelector("#output video");
    });
    await page
      .locator("#upload")
      .setInputFiles(path.resolve("test/fixtures/sample.webm"));
    await page.waitForFunction(
      () => document.querySelectorAll(".card").length === 3,
    );
    await page.locator(".card").last().locator(".name").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#previewName").textContent === "sample.webm" &&
        document.querySelector("#preview video")?.readyState >= 3,
    );
    await page.locator('[data-command="fade"]').click();
    await output.waitForFunction(
      () =>
        document.querySelectorAll("#output video").length === 1 &&
        !document.querySelector("#output video").paused &&
        window.outgoing !== document.querySelector("#output video"),
    );
    assert.equal(await output.evaluate(() => window.outgoing.paused), true);
    await output.evaluate(() => {
      window.lastVideo = document.querySelector("#output video");
    });
    await page.locator('[data-command="clear"]').click();
    await output.waitForFunction(
      () => !document.querySelector("#output video"),
    );
    assert.equal(await output.evaluate(() => window.lastVideo.paused), true);
    // Confirm the build did not accidentally include developer data or tests.
    const archiveRoot = await application.evaluate(({ app }) =>
      app.getAppPath(),
    );
    assert.ok(archiveRoot.endsWith("app.asar"));
    const packagedFiles = require("@electron/asar").listPackage(archiveRoot);
    for (const name of ["data", "test", ".git", ".env"]) {
      assert.ok(
        !packagedFiles.some(
          (file) => file === "/" + name || file.startsWith("/" + name + "/"),
        ),
        `Unexpected bundled path: ${name}`,
      );
    }
    console.log(
      "Packaged app OK: automatic login, Japanese image upload, native decoder, CUT, transparent OUT alpha, CLEAR, BLACK, native clipboard copy, monitor checkerboard, vertical library, separate numbers, stable CLEAR controls, rename dialog, timed copy feedback, video/audio/WASM validation, remaining time, isolated data.",
    );
  } finally {
    await application.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
