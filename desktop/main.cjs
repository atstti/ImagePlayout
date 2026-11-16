const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const {
  receiverUrls,
  mayAuthenticate,
  isReceiverUrl,
} = require("./runtime.cjs");

app.setName("Image Playout LAN");
if (process.env.IMAGE_PLAYOUT_USER_DATA)
  app.setPath("userData", path.resolve(process.env.IMAGE_PLAYOUT_USER_DATA));
let operatorWindow;
let runtime;
let origin;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (operatorWindow) {
      if (operatorWindow.isMinimized()) operatorWindow.restore();
      operatorWindow.show();
      operatorWindow.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("Image Playout LANを起動できません", error.message);
      app.quit();
    });
}

async function start() {
  const root = path.join(__dirname, "..");
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "config.json"), "utf8"),
  );
  const port = Number(process.env.PORT || config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORTは1〜65535で指定してください。");
  const { createApp } = await import(
    pathToFileURL(path.join(root, "src/server.js")).href
  );
  // Keep images and credentials outside the signed/read-only application bundle.
  runtime = createApp({ dir: path.join(app.getPath("userData"), "data") });
  await new Promise((resolve, reject) => {
    runtime.server.once("error", (error) =>
      reject(
        Error(
          error.code === "EADDRINUSE"
            ? `${port}番ポートが使用中です。先に起動したImage Playout LANや、npm startの画面を終了してから再度開いてください。`
            : `LANサーバーの起動に失敗しました: ${error.message}`,
        ),
      ),
    );
    runtime.server.listen(port, config.host, resolve);
  });
  origin = `http://127.0.0.1:${port}`;
  operatorWindow = new BrowserWindow({
    width: 1400,
    height: 950,
    minWidth: 850,
    minHeight: 650,
    title: "Image Playout LAN",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const password =
    process.env.ADMIN_PASSWORD ||
    fs.readFileSync(runtime.passwordFile, "utf8").trim();
  app.on("login", (event, contents, details, authInfo, callback) => {
    if (mayAuthenticate(authInfo, contents, operatorWindow.webContents, port)) {
      event.preventDefault();
      callback("admin", password);
    }
  });
  operatorWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isReceiverUrl(url, origin)) shell.openExternal(url).catch(showError);
    return { action: "deny" };
  });
  operatorWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  operatorWindow.once("ready-to-show", () => operatorWindow.show());
  const connectionInfo = async () => {
    const urls = receiverUrls(port);
    const text = urls.length
      ? urls.join("\n")
      : "LANのIPv4アドレスが見つかりません。同じLANへ接続してから確認してください。";
    const { response } = await dialog.showMessageBox(operatorWindow, {
      type: "info",
      title: "受信PCの接続先",
      message: "受信PCのブラウザで開くURL",
      detail: `${text}\n\n操作PCと同じLANに接続してください。VPNや仮想ネットワークのアドレスが含まれる場合は、実際に使うLANのアドレスを選んでください。`,
      buttons: urls.length ? ["URLをコピー", "閉じる"] : ["閉じる"],
      cancelId: urls.length ? 1 : 0,
    });
    if (urls.length && response === 0) clipboard.writeText(urls.join("\n"));
  };
  const openData = async () => {
    const error = await shell.openPath(path.dirname(runtime.passwordFile));
    if (error) throw Error(error);
  };
  const menu = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu", label: "Image Playout LAN" }]
      : []),
    {
      label: "送出",
      submenu: [
        {
          label: "受信PCの接続先…",
          click: () => connectionInfo().catch(showError),
        },
        {
          label: "このPCでOUTを開く",
          click: () =>
            shell.openExternal(`${origin}/receiver`).catch(showError),
        },
        { type: "separator" },
        {
          label: "画像・パスワードの保存先を開く",
          click: () => openData().catch(showError),
        },
        { type: "separator" },
        { role: "quit", label: "終了" },
      ],
    },
    {
      label: "編集",
      submenu: [
        { role: "undo", label: "取り消す" },
        { role: "redo", label: "やり直す" },
        { type: "separator" },
        { role: "cut", label: "切り取り" },
        { role: "copy", label: "コピー" },
        { role: "paste", label: "貼り付け" },
        { role: "selectAll", label: "すべて選択" },
      ],
    },
    {
      label: "表示",
      submenu: [
        { role: "resetZoom", label: "標準サイズ" },
        { role: "zoomIn", label: "拡大" },
        { role: "zoomOut", label: "縮小" },
        { role: "togglefullscreen", label: "全画面" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  await operatorWindow.loadURL(origin);
}
function showError(error) {
  dialog.showErrorBox("操作に失敗しました", error.message);
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (runtime) {
    for (const ws of runtime.wss.clients) ws.terminate();
    runtime.wss.close();
    runtime.server.close();
  }
});
