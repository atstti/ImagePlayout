import { Player, connect } from "./player.js";
const transparentBackground =
  new URLSearchParams(location.search).get("transparent") === "1";
if (transparentBackground)
  document.documentElement.classList.add("transparent-output");
let session = false,
  lastStatus = { id: null, outputMode: "black", seq: -1, error: null };
const player = new Player(
  document.querySelector("#output"),
  (status) => {
    lastStatus = status;
    if (!status.error) document.querySelector("#audioUnlock").hidden = true;
    connection.send({ type: "status", ...status });
  },
  {
    transparentBackground,
    onBlocked: () => {
      document.querySelector("#audioUnlock").hidden = false;
    },
  },
);
const connection = connect(
  "receiver",
  async (message, socket) => {
    if (message.type === "state") {
      player.setMedia(message.images);
      player.setClock(message.serverTime);
      player.configure(message.settings);
      if (player.blocked && message.settings.videoMuted)
        await player.retryBlocked();
      if (!session) {
        session = true;
        player.seq = -1;
        await player.show({
          id: message.program,
          outputMode: message.outputMode,
          startedAt: message.programStartedAt,
        paused: message.programPaused,
        position: message.programPosition,
          seq: message.seq,
          transition: "cut",
          duration: 0,
        });
      }
      if (message.preview)
        player.preload(message.preview).catch((e) => {
          lastStatus.error = e.message;
        });
    }
    if (message.type === "prepare") {
      try {
        await player.preload(message.id);
        socket.send(
          JSON.stringify({
            type: "ack",
            id: message.id,
            token: message.token,
            ok: true,
          }),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "ack",
            id: message.id,
            token: message.token,
            ok: false,
            error: error.message,
          }),
        );
      }
    }
    if (message.type === "program") {
      document.querySelector("#audioUnlock").hidden = true;
      await player.show(message);
    }
  },
  (connected) => {
    if (!connected) session = false;
  },
);
setInterval(
  () =>
    connection.send({
      type: "status",
      ...lastStatus,
      playback: player.playbackStatus(),
    }),
  5000,
);
document.querySelector("#audioUnlock").onclick = async () => {
  const button = document.querySelector("#audioUnlock");
  button.disabled = true;
  try {
    await player.retryBlocked();
  } finally {
    button.disabled = false;
  }
};
async function fullscreen() {
  try {
    if (!document.fullscreenElement)
      await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (e) {
    lastStatus.error = "全画面表示に失敗: " + e.message;
  }
}
document.addEventListener("dblclick", fullscreen);
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "f") fullscreen();
});
