const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

import {
  AdminWebsocket,
  AppWebsocket
} from '@holochain/conductor-api';

import Websocket from 'ws';

import {WsClient as HolochainWsClient} from '@holochain/conductor-api/lib/websocket/client'

import ReconnectingWebSocket from 'reconnecting-websocket';

class HcAdminWebSocket extends AdminWebsocket {
  constructor(url, ...args) {
    super(new HolochainWsClient(new ReconnectingWebSocket(url, [], {
      WebSocket: Websocket,
      maxRetries: 300,
    })), ...args);
  };

  close(): Promise<void> {
    this.client.socket.close();
    return this.closed();
  }

  opened = () => new Promise<void>((resolve, reject) => this.client.socket.addEventListener("open", () => resolve()));
  closed = () => new Promise<void>((resolve, reject) => this.client.socket.addEventListener("close", () => resolve()));
}

class HcAppWebSocket extends AppWebsocket {
  constructor(url, ...args) {
    super(new HolochainWsClient(new ReconnectingWebSocket(url, [], {
      WebSocket: Websocket,
      maxRetries: 300,
    })), ...args);
  };

  close(): Promise<void> {
    this.client.socket.close();
    return this.closed();
  }

  opened = () => new Promise<void>((resolve, reject) => this.client.socket.addEventListener("open", () => resolve()));
  closed = () => new Promise<void>((resolve, reject) => this.client.socket.addEventListener("close", () => resolve()));
}

export {
  HcAdminWebSocket, HcAppWebSocket
}
