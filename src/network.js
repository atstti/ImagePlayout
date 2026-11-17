import { networkInterfaces } from "node:os";

export function transparentOutputUrl(origin, interfaces = networkInterfaces()) {
  const url = new URL("/receiver?transparent=1", origin);
  const localHosts = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];
  if (localHosts.includes(url.hostname)) {
    const addresses = [
      ...new Set(
        Object.values(interfaces)
          .flat()
          .filter(Boolean)
          .filter((item) => item.family === "IPv4" && !item.internal)
          .map((item) => item.address),
      ),
    ];
    // Prefer LAN addresses to public/VPN addresses when the desktop uses loopback.
    const privateAddress = addresses.find((address) =>
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address),
    );
    if (privateAddress || addresses[0])
      url.hostname = privateAddress || addresses[0];
  }
  return url.href;
}
