import fs from "node:fs/promises";
import { createRequire } from "node:module";
import sharp from "sharp";
import mediaInfoFactory from "mediainfo.js";
const require = createRequire(import.meta.url);
const wasmPath = require.resolve("mediainfo.js/MediaInfoModule.wasm");
let queue = Promise.resolve();

export async function inspectMedia(file, config) {
  const handle = await fs.open(file.path, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    const mp4 = header.toString("ascii", 4, 8) === "ftyp";
    const webm = header.readUInt32BE(0) === 0x1a45dfa3;
    if (mp4 || webm) {
      if (file.size > config.maxVideoUploadMB * 1024 * 1024)
        throw Error(`動画は${config.maxVideoUploadMB}MB以下にしてください`);
      const analyze = async () => {
        const parser = await mediaInfoFactory({
          format: "object",
          chunkSize: 256 * 1024,
          locateFile: () => wasmPath,
        });
        let bytes = 0;
        const started = Date.now();
        try {
          return await parser.analyzeData(file.size, async (size, offset) => {
            bytes += size;
            if (bytes > 64 * 1024 * 1024 || Date.now() - started > 15000)
              throw Error("動画のメタデータを解析できませんでした");
            const data = Buffer.alloc(
              Math.min(size, Math.max(0, file.size - offset)),
            );
            const result = await handle.read(data, 0, data.length, offset);
            return data.subarray(0, result.bytesRead);
          });
        } finally {
          parser.close();
        }
      };
      // MediaInfo is stateful; serialize validation to bound memory and CPU use.
      const analysis = queue.then(analyze);
      queue = analysis.catch(() => {});
      const tracks = (await analysis)?.media?.track || [];
      const general = tracks.find((t) => t["@type"] === "General");
      const video = tracks.filter((t) => t["@type"] === "Video");
      const audio = tracks.filter((t) => t["@type"] === "Audio");
      const expected = mp4 ? "MPEG-4" : "WebM";
      if (general?.Format !== expected || video.length !== 1)
        throw Error("映像を含むMP4 / WebMを指定してください");
      if (!(mp4 ? ["AVC"] : ["VP8", "VP9"]).includes(video[0].Format))
        throw Error("MP4はH.264、WebMはVP8 / VP9の動画に対応しています");
      if (
        audio.some(
          (t) => !(mp4 ? ["AAC"] : ["Opus", "Vorbis"]).includes(t.Format),
        )
      )
        throw Error("MP4の音声はAAC、WebMの音声はOpus / Vorbisにしてください");
      const width = Number(video[0].Width),
        height = Number(video[0].Height),
        duration = Number(general.Duration || video[0].Duration);
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width * height > config.maxPixels ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 86400
      )
        throw Error("動画の解像度または時間が不正、もしくは上限超過です");
      return {
        kind: "video",
        mime: mp4 ? "video/mp4" : "video/webm",
        width,
        height,
        duration,
        hasAudio: audio.length > 0,
        videoCodec: video[0].Format,
        audioCodec: audio[0]?.Format || null,
      };
    }
    if (file.size > config.maxUploadMB * 1024 * 1024)
      throw Error(`画像は${config.maxUploadMB}MB以下にしてください`);
    const data = await fs.readFile(file.path);
    const metadata = await sharp(data, {
      limitInputPixels: config.maxPixels,
      animated: true,
    }).metadata();
    const formats = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };
    if (!formats[metadata.format])
      throw Error("JPEG / PNG / WebP / GIF / MP4 / WebMに対応しています");
    await sharp(data, {
      limitInputPixels: config.maxPixels,
      animated: true,
    }).stats();
    return {
      kind: "image",
      mime: formats[metadata.format],
      width: metadata.width,
      height: metadata.pageHeight || metadata.height,
    };
  } finally {
    await handle.close();
  }
}
