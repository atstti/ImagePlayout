const os = require("node:os");

function receiverUrls(port, interfaces = os.networkInterfaces()) {
  const addresses = Object.values(interfaces)
    .flat()
    .filter(Boolean)
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}/receiver`);
  return [...new Set(addresses)];
}

// Never pass the operator password to proxies, external sites or other windows.
function mayAuthenticate(authInfo, webContents, operatorContents, port) {
  return (
    webContents === operatorContents &&
    !authInfo.isProxy &&
    authInfo.host === "127.0.0.1" &&
    Number(authInfo.port) === port
  );
}

function isReceiverUrl(value, origin) {
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      url.pathname === "/receiver" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

module.exports = { receiverUrls, mayAuthenticate, isReceiverUrl };
