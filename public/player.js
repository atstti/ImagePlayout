export class Player {
  constructor(
    container,
    onStatus = () => {},
    { transparentBackground = false } = {},
  ) {
    this.container = container;
    this.onStatus = onStatus;
    this.seq = -1;
    this.generation = 0;
    this.cache = new Map();
    this.current = null;
    this.displayId = null;
    this.transparentBackground = transparentBackground;
    this.settings = { fit: "contain", background: "#000000" };
  }
  configure(settings) {
    this.settings = settings;
    this.applyBackground();
    for (const img of this.container.children)
      img.style.objectFit = settings.fit;
  }
  applyBackground() {
    // BLACK remains opaque in both modes. A settings heartbeat during FADE
    // must use the incoming image, rather than the last completed image.
    this.container.style.backgroundColor =
      this.displayId === null
        ? "#000000"
        : this.transparentBackground
          ? "transparent"
          : this.settings.background;
  }
  async preload(id) {
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => {
        img.src = "";
        reject(Error("画像読み込みがタイムアウトしました"));
      }, 7000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(Error("画像読み込みに失敗しました: " + id));
      };
      img.src = "/media/" + encodeURIComponent(id);
    });
    this.cache.set(id, promise);
    promise.catch(() => this.cache.delete(id));
    while (this.cache.size > 12)
      this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async show(command) {
    if (command.seq <= this.seq) return;
    this.seq = command.seq;
    const generation = ++this.generation;
    try {
      const source = await this.preload(command.id);
      if (generation !== this.generation) return;
      // Preserve the currently composited frame when a rapid command interrupts a fade.
      for (const img of this.container.children)
        for (const animation of img.getAnimations()) {
          animation.commitStyles();
          animation.cancel();
        }
      this.displayId = command.id;
      this.applyBackground();
      const old = [...this.container.children];
      const img = source ? source.cloneNode() : document.createElement("img");
      if (!source) {
        img.removeAttribute("src");
        img.style.backgroundColor = "#000";
        img.alt = "";
      }
      img.style.objectFit = this.settings.fit;
      img.style.opacity = "1";
      this.container.append(img);
      const duration = command.transition === "fade" ? command.duration : 0;
      const animations = [];
      if (duration) {
        animations.push(
          img.animate([{ opacity: 0 }, { opacity: 1 }], {
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
        await Promise.all(animations.map((a) => a.finished.catch(() => {})));
      }
      if (generation !== this.generation) return;
      for (const a of animations) a.cancel();
      old.forEach((el) => el.remove());
      if (!source) img.remove();
      this.current = command.id;
      this.onStatus({ id: command.id, seq: command.seq, error: null });
    } catch (e) {
      if (generation === this.generation)
        this.onStatus({ id: this.current, seq: command.seq, error: e.message });
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
