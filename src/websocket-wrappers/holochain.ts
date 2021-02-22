const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

import {
  AdminWebsocket,
  AppWebsocket
} from '@holochain/conductor-api';
import ConnectionMonitor from './connection_monitor';

const HOLOCHAIN_WS_CLIENT_OPTS = {
  "reconnectInterval": 1000,
  "maxReconnects": 300,
};

class HcAdminWebSocket extends AdminWebsocket {
  connectionMonitor: ConnectionMonitor;

  constructor(url, ...args) {
    super(null, ...args);
    console.log("done super")
    const reconnect = async () => {
      this.client = (await AdminWebsocket.connect(url)).client;
      return this.client.socket;
    };
    this.connectionMonitor = new ConnectionMonitor(reconnect, HOLOCHAIN_WS_CLIENT_OPTS);
  };

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

class HcAppWebSocket extends AppWebsocket {
  connectionMonitor: ConnectionMonitor;

  constructor(url, ...args) {
    super(undefined, ...args);
    console.log("done super")
    const reconnect = async () => {
      this.client = (await AppWebsocket.connect(url)).client;
      return this.client.socket;
    };
    this.connectionMonitor = new ConnectionMonitor(reconnect, HOLOCHAIN_WS_CLIENT_OPTS);
  };

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

export {
  HcAdminWebSocket, HcAppWebSocket
}
