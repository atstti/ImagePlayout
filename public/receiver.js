import { Player, connect } from "./player.js";
let session = false,
  lastStatus = { id: null, seq: -1, error: null };
const player = new Player(document.querySelector("#output"), (status) => {
  lastStatus = status;
  connection.send({ type: "status", ...status });
});
const connection = connect(
  "receiver",
  async (message, socket) => {
    if (message.type === "state") {
      player.configure(message.settings);
      if (!session) {
        session = true;
        player.seq = -1;
        await player.show({
          id: message.program,
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
      } catch {
        socket.send(
          JSON.stringify({
            type: "ack",
            id: message.id,
            token: message.token,
            ok: false,
          }),
        );
      }
    }
    if (message.type === "program") await player.show(message);
  },
  (connected) => {
    if (!connected) session = false;
  },
);
setInterval(() => connection.send({ type: "status", ...lastStatus }), 5000);
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
