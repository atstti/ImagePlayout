// Smoke-test the actual packaged Electron app, including its bundled sharp binary.
const { _electron: electron } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");
const sharp = require("sharp");

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
    const receiver = await fetch(`http://127.0.0.1:${port}/receiver`);
    assert.equal(receiver.status, 200);
    assert.ok(fs.existsSync(path.join(dir, "data", "admin-password.txt")));
    assert.deepEqual(errors, []);
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
      "Packaged app OK: automatic login, Japanese image upload, native decoder, CUT, receiver, isolated data.",
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
