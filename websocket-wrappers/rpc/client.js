const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const RPCWebSocket = require('rpc-websockets').Client;

class WebSocket extends RPCWebSocket {
  constructor(...args) {
    super(...args);
    this.connectionMonitor = new ConnectionMonitor(this.client, this.connect, 'RPC', {
      "reconnect_interval": 1000,
      "max_reconnects": 300,
    });
  }

  close() {
    this.connectionMonitor.close();
  }

  opened = async (timeout = 1000) => await this.connectionMonitor.waitWsOpened(timeout);
  closed = async (timeout = 1000) => await this.connectionMonitor.waitWsClosed(timeout);
  setSocketInfo = ({
    port,
    name
  }) => this.connectionMonitor.setSocketInfo({
    port,
    name
  });
}

module.exports = WebSocket;
