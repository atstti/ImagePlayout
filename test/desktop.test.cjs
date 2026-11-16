const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  receiverUrls,
  mayAuthenticate,
  isReceiverUrl,
} = require("../desktop/runtime.cjs");

test("デスクトップ：LAN用URLは外部IPv4のみを重複なく表示", () => {
  assert.deepEqual(
    receiverUrls(8080, {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      en0: [
        { family: "IPv4", address: "192.168.1.10", internal: false },
        { family: "IPv6", address: "::1", internal: false },
      ],
      duplicate: [{ family: "IPv4", address: "192.168.1.10", internal: false }],
    }),
    ["http://192.168.1.10:8080/receiver"],
  );
});

test("デスクトップ：自動認証とOUT起動の対象を同一アプリ内に制限", () => {
  const contents = {};
  const info = { host: "127.0.0.1", port: 8080, isProxy: false };
  assert.equal(mayAuthenticate(info, contents, contents, 8080), true);
  for (const changed of [
    { host: "example.com" },
    { port: 9000 },
    { isProxy: true },
  ]) {
    assert.equal(
      mayAuthenticate({ ...info, ...changed }, contents, contents, 8080),
      false,
    );
  }
  assert.equal(mayAuthenticate(info, {}, contents, 8080), false);
  const origin = "http://127.0.0.1:8080";
  assert.equal(isReceiverUrl(origin + "/receiver", origin), true);
  for (const value of [
    "https://evil.example/receiver",
    "file:///tmp/receiver",
    origin + "/",
    "not a url",
    "http://admin:secret@127.0.0.1:8080/receiver",
  ]) {
    assert.equal(isReceiverUrl(value, origin), false);
  }
});
