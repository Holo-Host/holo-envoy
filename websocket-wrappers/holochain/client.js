const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const {
  AdminWebsocket,
  AppWebsocket
} = require('@holochain/conductor-api');
const ConnectionMonitor = require('../utils.js');

const HOLOCHAIN_WS_CLIENT_OPTS = {
  "reconnect_interval": 1000,
  "max_reconnects": 300,
};

class HcAdminWebSocket extends AdminWebsocket {
  constructor(client, connect, ...args) {
    super(...args);
    this.client = client;
    this.connectionMonitor = new ConnectionMonitor(client, connect, 'Holochain-WireMessage', HOLOCHAIN_WS_CLIENT_OPTS);
  };

  static async init(url) {
    const connect = super.connect;
    const adminWsClient = await super.connect(url);
    return new HcAdminWebSocket(adminWsClient.client, connect);
  }

  close() {
    this.connectionMonitor.close();
  }

  opened = async (timeout) => await this.connectionMonitor.waitWsOpened(timeout = 1000);
  closed = async (timeout) => await this.connectionMonitor.waitWsClosed(timeout = 1000);
  setSocketInfo = ({
    port,
    name
  }) => this.connectionMonitor.setSocketInfo({
    port,
    name
  });
}

class HcAppWebSocket extends AppWebsocket {
  constructor(client, connect, ...args) {
    super(...args);
    this.client = client;
    this.connectionMonitor = new ConnectionMonitor(client, connect, 'Holochain-WireMessage', HOLOCHAIN_WS_CLIENT_OPTS);
  };

  static async init(url) {
    const connect = super.connect;
    const appWsClient = await super.connect(url);
    return new HcAppWebSocket(appWsClient.client, connect);
  }

  opened = async (timeout) => await this.connectionMonitor.waitWsOpened(timeout = 1000);
  closed = async (timeout) => await this.connectionMonitor.waitWsClosed(timeout = 1000);
  setSocketInfo = ({
    port,
    name
  }) => this.connectionMonitor.setSocketInfo({
    port,
    name
  });
}

module.exports = {
  HcAdminWebSocket,
  HcAppWebSocket
}
