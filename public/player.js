export class Player {
  constructor(
    container,
    onStatus = () => {},
    {
      transparentBackground = false,
      paused = false,
      forceMuted = false,
      onBlocked = () => {},
    } = {},
  ) {
    this.container = container;
    this.onStatus = onStatus;
    this.onBlocked = onBlocked;
    this.transparentBackground = transparentBackground;
    this.pausedPreview = paused;
    this.forceMuted = forceMuted;
    this.seq = -1;
    this.generation = 0;
    this.cache = new Map();
    this.media = new Map();
    this.clockOffset = 0;
    this.current = null;
    this.displayId = null;
    this.displayMode = "black";
    this.currentMode = "black";
    this.active = null;
    this.pendingElement = null;
    this.currentCommand = null;
    this.blocked = null;
    this.settings = {
      fit: "contain",
      background: "#000000",
      videoLoop: false,
      videoMuted: false,
    };
  }
  setMedia(items) {
    this.media = new Map(items.map((item) => [item.id, item]));
    for (const [id, entry] of this.cache)
      if (
        !this.media.has(id) &&
        entry.element !== this.active &&
        !this.container.contains(entry.element)
      ) {
        this.dispose(entry.element);
        this.cache.delete(id);
      }
  }
  setClock(serverTime) {
    if (Number.isFinite(serverTime)) this.clockOffset = Date.now() - serverTime;
  }
  configure(settings) {
    this.settings = { ...this.settings, ...settings };
    this.applyBackground();
    for (const element of this.container.children) {
      element.style.objectFit = settings.fit;
      if (element.tagName === "VIDEO") this.configureVideo(element);
    }
  }
  configureVideo(video) {
    video.loop = this.settings.videoLoop === true;
    video.muted =
      this.pausedPreview ||
      this.forceMuted ||
      this.settings.videoMuted === true;
  }
  applyBackground() {
    this.container.style.backgroundColor =
      this.displayId === null
        ? this.displayMode === "clear"
          ? "transparent"
          : "#000000"
        : this.transparentBackground
          ? "transparent"
          : this.settings.background;
  }
  stop(element) {
    if (element?.tagName === "VIDEO") {
      element.playoutStopped = true;
      element.pause();
    }
  }
  dispose(element) {
    this.stop(element);
    if (element?.tagName === "VIDEO") {
      element.removeAttribute("src");
      element.load();
    }
  }
  prune() {
    const videos = () =>
      [...this.cache.values()].filter(
        (entry) => entry.element.tagName === "VIDEO",
      ).length;
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= 12 && videos() <= 3) break;
      if (
        entry.element === this.active ||
        entry.element === this.pendingElement ||
        this.container.contains(entry.element)
      )
        continue;
      this.dispose(entry.element);
      this.cache.delete(id);
    }
  }
  async preload(id) {
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id).promise;
    const video = this.media.get(id)?.kind === "video";
    const element = video ? document.createElement("video") : new Image();
    if (video) {
      element.preload = "auto";
      element.muted = true;
      element.playsInline = true;
      element.setAttribute("playsinline", "");
    }
    const entry = { element, promise: null };
    entry.promise = new Promise((resolve, reject) => {
      const loaded = video ? "canplay" : "load";
      const cleanup = () => {
        clearTimeout(timer);
        element.removeEventListener(loaded, success);
        element.removeEventListener("error", failure);
      };
      const success = () => {
        cleanup();
        resolve(element);
      };
      const failure = () => {
        cleanup();
        reject(
          Error(
            video
              ? "動画を読み込めません。形式・コーデック・ネットワークを確認してください"
              : "画像読み込みに失敗しました: " + id,
          ),
        );
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            Error(
              video
                ? "動画の事前読み込みがタイムアウトしました"
                : "画像読み込みがタイムアウトしました",
            ),
          );
        },
        video ? 18000 : 7000,
      );
      element.addEventListener(loaded, success);
      element.addEventListener("error", failure);
      element.src = "/media/" + encodeURIComponent(id);
      if (video) element.load();
    });
    this.cache.set(id, entry);
    entry.promise.catch(() => {
      if (this.cache.get(id) === entry) this.cache.delete(id);
      this.dispose(element);
    });
    if (video) {
      element.addEventListener("ended", () => {
        if (this.active === element) this.status(null);
      });
      element.addEventListener("error", () => {
        if (this.active === element)
          this.status("動画の再生中に読み込みエラーが発生しました");
      });
      element.addEventListener("pause", () => {
        if (
          this.active === element &&
          !this.pausedPreview &&
          !element.playoutStopped &&
          !element.ended &&
          !element.muted &&
          this.currentCommand
        ) {
          this.blocked = this.currentCommand;
          this.status(
            "音声の再生が停止しました。受信画面で音声を有効にしてください",
          );
          this.onBlocked(this.blocked);
        }
      });
    }
    this.prune();
    return entry.promise;
  }
  playbackStatus() {
    const video = this.active;
    if (video?.tagName !== "VIDEO") return null;
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration)
        ? video.duration
        : this.media.get(this.current)?.duration || 0,
      paused: video.paused,
      ended: video.ended,
      muted: video.muted,
      loop: video.loop,
    };
  }
  status(error) {
    this.onStatus({
      id: this.current,
      outputMode: this.currentMode,
      seq: this.seq,
      error,
      playback: this.playbackStatus(),
    });
  }
  retryBlocked() {
    const command = this.blocked;
    if (!command || command.seq !== this.seq) return Promise.resolve();
    // Start in the actual click handler for Safari/Chrome's user-gesture policy.
    const element = this.cache.get(command.id)?.element;
    if (element?.tagName === "VIDEO") {
      this.configureVideo(element);
      element.volume = 1;
      element.playoutStopped = false;
      element.play().catch(() => {});
    }
    return this.show(command, { retry: true });
  }
  async show(command, { retry = false } = {}) {
    if (command.seq < this.seq || (!retry && command.seq === this.seq)) return;
    this.seq = command.seq;
    const generation = ++this.generation;
    this.blocked = null;
    let source;
    try {
      source = await this.preload(command.id);
      if (generation !== this.generation) return;
      this.pendingElement = source;
      const isVideo = source?.tagName === "VIDEO";
      if (isVideo) {
        this.configureVideo(source);
        source.playoutStopped = false;
        const duration = source.duration;
        let position = 0;
        if (
          !this.pausedPreview &&
          Number.isFinite(command.startedAt) &&
          Number.isFinite(duration) &&
          duration > 0
        ) {
          const elapsed = Math.max(
            0,
            (Date.now() - this.clockOffset - command.startedAt) / 1000,
          );
          position = source.loop
            ? elapsed % duration
            : Math.min(elapsed, Math.max(0, duration - 0.01));
        }
        source.currentTime = position;
        source.volume = 1;
        if (this.pausedPreview) this.stop(source);
        else {
          let timer;
          try {
            await Promise.race([
              source.play(),
              new Promise((resolve, reject) => {
                timer = setTimeout(
                  () => reject(Error("動画の再生開始がタイムアウトしました")),
                  18000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (command.transition === "fade" && command.duration > 0)
          source.volume = 0;
        if (generation !== this.generation) {
          if (this.active !== source && !this.container.contains(source))
            this.stop(source);
          return;
        }
      }
      for (const element of this.container.children)
        for (const animation of element.getAnimations()) {
          animation.commitStyles();
          animation.cancel();
        }
      this.displayId = command.id;
      this.displayMode = command.outputMode || (command.id ? "image" : "black");
      this.applyBackground();
      const old = [...this.container.children].filter(
        (element) => element !== source,
      );
      const element = isVideo
        ? source
        : source
          ? source.cloneNode()
          : document.createElement("img");
      if (!source) {
        element.style.backgroundColor =
          this.displayMode === "clear" ? "transparent" : "#000";
        element.alt = "";
      }
      element.style.objectFit = this.settings.fit;
      element.style.opacity = "1";
      this.container.append(element);
      this.active = source ? element : null;
      this.pendingElement = null;
      this.currentCommand = command;
      const duration = command.transition === "fade" ? command.duration : 0;
      const animations = [];
      if (duration) {
        animations.push(
          element.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration,
            fill: "both",
          }),
        );
        for (const previous of old)
          animations.push(
            previous.animate(
              [{ opacity: getComputedStyle(previous).opacity }, { opacity: 0 }],
              { duration, fill: "both" },
            ),
          );
        const volumes = old
          .filter((el) => el.tagName === "VIDEO")
          .map((el) => [el, el.volume]);
        const started = performance.now();
        const fadeAudio = () => {
          if (generation !== this.generation) return;
          const progress = Math.min(
            1,
            (performance.now() - started) / duration,
          );
          if (isVideo) element.volume = progress;
          for (const [video, volume] of volumes)
            video.volume = volume * (1 - progress);
          if (progress < 1) requestAnimationFrame(fadeAudio);
        };
        fadeAudio();
        await Promise.all(
          animations.map((animation) => animation.finished.catch(() => {})),
        );
      }
      if (generation !== this.generation) return;
      for (const animation of animations) animation.cancel();
      old.forEach((previous) => {
        this.stop(previous);
        previous.remove();
      });
      if (!source) element.remove();
      if (isVideo) element.volume = 1;
      this.current = command.id;
      this.currentMode = this.displayMode;
      this.status(null);
      this.prune();
    } catch (error) {
      if (generation !== this.generation) return;
      this.pendingElement = null;
      if (source?.tagName === "VIDEO" && source !== this.active)
        this.stop(source);
      if (error.name === "NotAllowedError") {
        this.blocked = command;
        this.status(
          "音声の自動再生が制限されています。受信画面で「音声を有効にして再生」を押してください",
        );
        this.onBlocked(command);
      } else this.status(error.message);
    }
  }
}
export function connect(role, onMessage, onConnection) {
  let socket,
    timer,
    retry = 500;
  let stopped = false;
  const open = () => {
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?role=${role}`,
    );
    socket.onopen = () => {
      retry = 500;
      onConnection?.(true);
    };
    socket.onmessage = (e) => {
      try {
        Promise.resolve(onMessage(JSON.parse(e.data), socket)).catch(
          console.error,
        );
      } catch (err) {
        console.error(err);
      }
    };
    socket.onclose = () => {
      onConnection?.(false);
      if (!stopped) {
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 10000);
      }
    };
    socket.onerror = () => socket.close();
  };
  open();
  return {
    send: (m) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    },
    close: () => {
      stopped = true;
      clearTimeout(timer);
      socket.close();
    },
  };
}
