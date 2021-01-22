const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const RPCWebSocket = require('rpc-websockets').Client;

class WebSocket extends RPCWebSocket {
  constructor(...args) {
    super(...args);
    this.connectionMonitor = new ConnectionMonitor(this.client, this.connect, 'RPC', HOLOCHAIN_WS_CLIENT_OPTS);
  }

  opened = async (timeout) => await this.connectionMonitor.setWsOpened(timeout = 1000);
  closed = async (timeout) => await this.connectionMonitor.setWsClosed(timeout = 1000);
  setSocketInfo = ({
    port,
    name
  }) => this.connectionMonitor.setSocketInfo({
    port,
    name
  });
}

module.exports = WebSocket;