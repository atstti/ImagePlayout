import { test } from "node:test";
import assert from "node:assert/strict";
import { transparentOutputUrl } from "../src/network.js";
test("コピーURL：接続中のLANホストを維持し、ローカル起動時はLAN IPv4を選ぶ", () => {
  const interfaces = {
    loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    vpn: [{ family: "IPv4", internal: false, address: "100.64.1.2" }],
    lan: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
  };
  assert.equal(
    transparentOutputUrl("http://127.0.0.1:8080", interfaces),
    "http://192.168.1.20:8080/receiver?transparent=1",
  );
  assert.equal(
    transparentOutputUrl("http://192.168.1.99:9000", interfaces),
    "http://192.168.1.99:9000/receiver?transparent=1",
  );
  assert.equal(
    transparentOutputUrl("http://localhost:8080", {}),
    "http://localhost:8080/receiver?transparent=1",
  );
});
