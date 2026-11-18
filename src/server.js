import express from "express";
import multer from "multer";
import { inspectMedia } from "./media.js";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { transparentOutputUrl } from "./network.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const config = {
  maxVideoUploadMB: 500,
  videoPreloadTimeoutMs: 20000,
  ...JSON.parse(fs.readFileSync(path.join(root, "config.json"))),
};
export function createApp(options = {}) {
  const dir = options.dir || process.env.DATA_DIR || path.join(root, "data");
  const store = new Store(dir, config.fadeMs);
  const s = store.state;
  const tempDir = path.join(dir, "uploads");
  fs.mkdirSync(tempDir, { recursive: true });
  for (const file of fs.readdirSync(tempDir)) {
    if (
      /^[0-9a-f-]{36}$/.test(file) &&
      Date.now() - fs.statSync(path.join(tempDir, file)).mtimeMs > 86400000
    )
      fs.rmSync(path.join(tempDir, file), { force: true });
  }
  const secretFile = path.join(dir, "admin-password.txt");
  if (!fs.existsSync(secretFile))
    fs.writeFileSync(secretFile, randomBytes(18).toString("base64url"), {
      mode: 0o600,
    });
  const password =
    options.password ||
    process.env.ADMIN_PASSWORD ||
    fs.readFileSync(secretFile, "utf8").trim();
  const app = express(),
    server = http.createServer(app),
    wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const peers = new Map();
  const disconnected = [];
  let pending = null;
  const authorized = (req) => {
    const value = Buffer.from(
      (req.headers.authorization || "").replace(/^Basic /, ""),
      "base64",
    ).toString();
    const actual = Buffer.from(value),
      expected = Buffer.from("admin:" + password);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  const auth = (req, res, next) =>
    authorized(req)
      ? next()
      : res
          .status(401)
          .set(
            "WWW-Authenticate",
            'Basic realm="Image Playout LAN", charset="UTF-8"',
          )
          .send("操作には認証が必要です");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`
    )
      return res.status(403).send("接続元が不正です");
    next();
  });
  const send = (ws, m) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const receivers = () =>
    [...peers.values()].filter((p) => p.role === "receiver");
  const broadcast = (m) => {
    for (const ws of peers.keys()) send(ws, m);
  };
  const status = () => ({
    type: "state",
    ...s,
    receivers: [...receivers(), ...disconnected],
    serverTime: Date.now(),
  });
  const sync = () => broadcast(status());
  app.get("/", auth, (req, res) =>
    res.sendFile(path.join(root, "public/index.html")),
  );
  app.get("/receiver", (req, res) =>
    res.sendFile(path.join(root, "public/receiver.html")),
  );
  app.use(
    "/assets",
    express.static(path.join(root, "public"), { index: false }),
  );
  app.get("/media/:id", (req, res) => {
    const img = store.image(req.params.id);
    if (!img) return res.sendStatus(404);
    res
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .type(img.mime)
      .sendFile(path.join(dir, "images", img.id));
  });
  app.use("/api", auth, express.json({ limit: "128kb" }));
  app.get("/api/output-url", (req, res) => {
    res.set("Cache-Control", "no-store").json({
      url: transparentOutputUrl(`${req.protocol}://${req.get("host")}`),
    });
  });
  app.get("/api/state", (req, res) => res.json(status()));
  const upload = multer({
    storage: multer.diskStorage({
      destination: tempDir,
      filename: (req, file, callback) => callback(null, randomUUID()),
    }),
    limits: {
      fileSize:
        Math.max(config.maxUploadMB, config.maxVideoUploadMB) * 1024 * 1024,
      files: 1,
      fields: 0,
    },
  });
  app.post("/api/images", upload.single("image"), async (req, res, next) => {
    let destination;
    try {
      if (!req.file) throw Error("画像または動画ファイルを指定してください");
      const metadata = await inspectMedia(req.file, config);
      const img = {
        id: randomUUID(),
        name: Buffer.from(req.file.originalname, "latin1")
          .toString("utf8")
          .slice(0, 200),
        size: req.file.size,
        ...metadata,
      };
      destination = path.join(dir, "images", img.id);
      fs.renameSync(req.file.path, destination);
      const previousPreview = s.preview;
      s.images.push(img);
      if (!s.preview) s.preview = img.id;
      try {
        store.save();
      } catch (error) {
        s.images.pop();
        s.preview = previousPreview;
        fs.rmSync(destination, { force: true });
        throw error;
      }
      sync();
      res.status(201).json(img);
    } catch (error) {
      next(error);
    } finally {
      if (req.file) fs.rmSync(req.file.path, { force: true });
    }
  });
  app.patch("/api/images/:id", (req, res, next) => {
    try {
      const img = store.image(req.params.id);
      if (!img) return res.sendStatus(404);
      if (typeof req.body.name !== "string" || !req.body.name.trim())
        throw Error("名称を入力してください");
      img.name = req.body.name.trim().slice(0, 200);
      store.save();
      sync();
      res.json(img);
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/images/:id", (req, res) => {
    const id = req.params.id;
    if (id === s.program || pending?.id === id)
      return res
        .status(409)
        .json({ error: "送出中または準備中の画像は削除できません" });
    if (!store.image(id)) return res.sendStatus(404);
    s.images = s.images.filter((i) => i.id !== id);
    if (s.preview === id) s.preview = s.images[0]?.id || null;
    store.save();
    fs.unlinkSync(path.join(dir, "images", id));
    sync();
    res.sendStatus(204);
  });
  app.post("/api/reorder", (req, res, next) => {
    try {
      const ids = req.body.ids;
      if (
        !Array.isArray(ids) ||
        ids.length !== s.images.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !store.image(id))
      )
        throw Error("並び順が不正です");
      s.images = ids.map((id) => store.image(id));
      store.save();
      sync();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/settings", (req, res, next) => {
    try {
      const { fit, background, fadeMs, take } = req.body;
      const videoLoop = req.body.videoLoop ?? s.settings.videoLoop;
      const videoMuted = req.body.videoMuted ?? s.settings.videoMuted;
      if (
        !["contain", "cover", "fill"].includes(fit) ||
        !/^#[0-9a-f]{6}$/i.test(background) ||
        !Number.isInteger(fadeMs) ||
        fadeMs < 0 ||
        fadeMs > 10000 ||
        !["cut", "fade"].includes(take) ||
        typeof videoLoop !== "boolean" ||
        typeof videoMuted !== "boolean"
      )
        throw Error("表示設定が不正です");
      s.settings = { fit, background, fadeMs, take, videoLoop, videoMuted };
      store.save();
      sync();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  const commit = (id, transition, duration, outputMode) => {
    const command = store.take(id, transition, duration, outputMode);
    broadcast(command);
    sync();
  };
  app.post("/api/command", async (req, res, next) => {
    try {
      const { action, id } = req.body;
      if (action === "preview") {
        if (!store.image(id)) throw Error("画像が存在しません");
        s.preview = id;
        store.save();
        sync();
        return res.json({ ok: true });
      }
      if (action === "next") {
        store.next();
        store.save();
        sync();
        return res.json({ ok: true });
      }
      if (["black", "clear"].includes(action)) {
        if (pending) pending.finish(false);
        commit(null, "cut", 0, action);
        return res.json({ ok: true });
      }
      if (!["cut", "fade", "take"].includes(action))
        throw Error("不明な操作です");
      if (pending)
        return res.status(409).json({ error: "メディアの送出準備中です" });
      if (!store.image(s.preview)) throw Error("PREVIEW画像を選択してください");
      const target = s.preview,
        transition = action === "take" ? s.settings.take : action;
      const ready = await new Promise((resolve) => {
        const waiting = new Set(
          [...peers].filter(([, p]) => p.role === "receiver").map(([ws]) => ws),
        );
        const token = randomUUID();
        let timer;
        pending = {
          id: target,
          token,
          waiting,
          finish: (ok) => {
            clearTimeout(timer);
            pending = null;
            resolve(ok);
          },
        };
        if (!waiting.size) return pending.finish(true);
        timer = setTimeout(
          () => pending?.finish(false),
          store.image(target)?.kind === "video"
            ? config.videoPreloadTimeoutMs
            : config.preloadTimeoutMs,
        );
        for (const ws of waiting)
          send(ws, { type: "prepare", id: target, token });
      });
      if (!ready)
        return res.status(409).json({
          error:
            "受信PCの読み込みACKを確認できません。動画形式・再生許可・接続状態を確認してください",
        });
      commit(target, transition, s.settings.fadeMs);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.use((err, req, res, next) =>
    res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? `画像は${config.maxUploadMB}MB、動画は${config.maxVideoUploadMB}MB以下にしてください`
          : err.message || "処理に失敗しました",
    }),
  );
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    const role = url.searchParams.get("role");
    const origin = req.headers.origin;
    if (
      url.pathname !== "/ws" ||
      !["admin", "receiver"].includes(role) ||
      (role === "admin" && !authorized(req)) ||
      (origin &&
        origin !== `http://${req.headers.host}` &&
        origin !== `https://${req.headers.host}`)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer = {
        id: randomUUID(),
        role,
        address: req.socket.remoteAddress,
        lastSeen: Date.now(),
        imageId: null,
        error: null,
        seq: -1,
        connected: true,
      };
      peers.set(ws, peer);
      send(ws, status());
      sync();
      ws.on("pong", () => {
        peer.lastSeen = Date.now();
      });
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(raw);
          if (role !== "receiver") return;
          if (
            m.type === "ack" &&
            pending?.token === m.token &&
            pending.id === m.id &&
            pending.waiting.has(ws)
          ) {
            if (!m.ok) {
              peer.error =
                typeof m.error === "string"
                  ? m.error.slice(0, 200)
                  : "メディア読み込み失敗";
              pending.finish(false);
            } else {
              pending.waiting.delete(ws);
              if (!pending.waiting.size) pending.finish(true);
            }
          }
          if (m.type === "status") {
            peer.lastSeen = Date.now();
            peer.imageId = store.image(m.id) ? m.id : null;
            peer.outputMode = ["image", "black", "clear"].includes(m.outputMode)
              ? m.outputMode
              : null;
            if (
              m.playback &&
              Number.isFinite(m.playback.currentTime) &&
              Number.isFinite(m.playback.duration)
            ) {
              peer.playback = {
                currentTime: Math.min(
                  86400,
                  Math.max(0, m.playback.currentTime),
                ),
                duration: Math.min(86400, Math.max(0, m.playback.duration)),
                paused: !!m.playback.paused,
                ended: !!m.playback.ended,
                muted: !!m.playback.muted,
              };
            } else peer.playback = null;
            peer.seq = Number.isSafeInteger(m.seq) ? m.seq : -1;
            peer.error =
              typeof m.error === "string" ? m.error.slice(0, 200) : null;
            sync();
          }
        } catch {
          send(ws, { type: "error", error: "メッセージが不正です" });
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (pending?.waiting.has(ws)) pending.finish(false);
        if (peer.role === "receiver") {
          disconnected.unshift({ ...peer, connected: false });
          disconnected.splice(20);
        }
        peers.delete(ws);
        sync();
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const [ws, p] of peers) {
      if (Date.now() - p.lastSeen > 30000) ws.terminate();
      else ws.ping();
    }
    sync();
  }, 10000);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  return { app, server, wss, store, passwordFile: secretFile };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = createApp();
  const port = Number(process.env.PORT || config.port);
  runtime.server.listen(port, config.host, () =>
    console.log(
      `Image Playout LAN: http://localhost:${port}\n受信URL: http://SERVER_IP:${port}/receiver\nユーザー: admin / パスワード保存先: ${runtime.passwordFile}`,
    ),
  );
}
