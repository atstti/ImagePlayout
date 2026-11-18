import fs from "node:fs";
import path from "node:path";
export class Store {
  constructor(dir, fadeMs = 500, maxVideoUploadMB = 2048) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
    this.file = path.join(dir, "state.json");
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {
          images: [],
          preview: null,
          program: null,
          seq: 0,
          settings: {
            fit: "contain",
            background: "#000000",
            fadeMs,
            take: "fade",
          },
        };
    // Existing saved states used null for BLACK; retain that behavior.
    this.state.previewMode ??= this.state.preview ? "image" : "empty";
    this.state.outputMode ??= this.state.program ? "image" : "black";
    this.state.settings.maxVideoUploadMB ??= maxVideoUploadMB;
    this.state.settings.videoLoop ??= false;
    this.state.settings.videoMuted ??= false;
    this.state.programStartedAt ??= null;
    this.state.programPaused ??= false;
    this.state.programPosition ??= 0;
  }
  save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.state, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  image(id) {
    return this.state.images.find((i) => i.id === id);
  }
  next() {
    const a = this.state.images;
    this.state.previewMode = a.length ? "image" : "empty";
    this.state.preview = a.length
      ? a[(a.findIndex((i) => i.id === this.state.preview) + 1) % a.length].id
      : null;
  }
  playback(action) {
    const media = this.image(this.state.program);
    if (media?.kind !== "video") throw Error("PROGRAMに動画がありません");
    const s = this.state;
    let position = s.programPaused ? s.programPosition : Math.max(0, (Date.now() - s.programStartedAt) / 1000);
    position = s.settings.videoLoop ? position % media.duration : Math.min(position, media.duration);
    s.programPaused = action === "pause";
    s.programPosition = position;
    s.programStartedAt = Date.now() - position * 1000;
    s.seq++;
    this.save();
    return { type: "program", id: s.program, outputMode: s.outputMode,
      startedAt: s.programStartedAt, paused: s.programPaused, position,
      seq: s.seq, transition: "cut", duration: 0 };
  }
  take(id, transition, duration, outputMode = id === null ? "black" : "image") {
    if (id !== null && !this.image(id)) throw Error("画像が存在しません");
    if (!["cut", "fade"].includes(transition))
      throw Error("トランジションが不正です");
    if (!Number.isInteger(duration) || duration < 0 || duration > 10000)
      throw Error("FADE時間は0〜10000msです");
    if (
      id === null
        ? !["black", "clear"].includes(outputMode)
        : outputMode !== "image"
    )
      throw Error("出力モードが不正です");
    this.state.outputMode = outputMode;
    this.state.program = id;
    this.state.programStartedAt =
      this.image(id)?.kind === "video" ? Date.now() : null;
    this.state.programPaused = false;
    this.state.programPosition = 0;
    this.state.seq++;
    this.save();
    return {
      type: "program",
      id,
      outputMode,
      startedAt: this.state.programStartedAt,
      paused: this.state.programPaused,
      position: this.state.programPosition,
      seq: this.state.seq,
      transition,
      duration,
    };
  }
}
