const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const {
  AdminWebsocket,
  AppWebsocket
} = require('@holochain/conductor-api');
import ConnectionMonitor from './connection_monitor';

const HOLOCHAIN_WS_CLIENT_OPTS = {
  "reconnectInterval": 1000,
  "maxReconnects": 300,
};

class HcAdminWebSocket extends AdminWebsocket {
  constructor(client, url, ...args) {
    super(client, ...args);
    const reconnect = async () => {
      this.client = (await super.connect(url)).client;
      return this.client.socket;
    };
    this.connectionMonitor = new ConnectionMonitor(client, reconnect, HOLOCHAIN_WS_CLIENT_OPTS);
  };

  static async init(url) {
    const adminWsClient = await super.connect(url);
    return new HcAdminWebSocket(adminWsClient.client, url);
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
  constructor(client, url, ...args) {
    super(client, ...args);
    const reconnect = async () => {
      this.client = (await super.connect(url)).client;
      return this.client.socket;
    };
    this.connectionMonitor = new ConnectionMonitor(client, reconnect, HOLOCHAIN_WS_CLIENT_OPTS);
  };

  static async init(url) {
    const appWsClient = await super.connect(url);
    return new HcAppWebSocket(appWsClient.client, url);
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

export {
  HcAdminWebSocket, HcAppWebSocket
}
