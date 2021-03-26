const { init } = require("../src/shim.js");
const path = require("path");
const WH_SERVER_PORT = path.resolve(__dirname, './install-bundles/shim/socket');
const LAIR_SOCKET = path.resolve(__dirname, './install-bundles/keystore/socket');

init(LAIR_SOCKET, WH_SERVER_PORT, () => {
  return null;
});
