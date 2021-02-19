const async_with_timeout = require('./async_with_timeout.js');

const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
import { WsClient } from '@holochain/conductor-api/lib/websocket/client';
import Websocket from 'isomorphic-ws'

export default class ConnectionMonitor {
  socket: Websocket;
  connect: () => Promise<Websocket>;
  name: string = '';
  port: number | null = null;
  opts: {
    reconnectInterval: number | null,
    maxReconnects: number,
  };
  reconnections: number = 0;
  reconnectId: NodeJS.Timeout| null = null;
  desiredClosed = false;

  constructor(socket: Websocket, connect: () => Promise<Websocket>, {
    reconnectInterval,
    maxReconnects
  }) {
    this.socket = socket;
    this.connect = connect;
    this.opts = {
      "reconnectInterval": reconnectInterval ?? null,
      "maxReconnects": maxReconnects ?? Infinity
    }
    this.reconnections = 0;

    if (this.opts.reconnectInterval !== null) {
      this.socket.on("close", this.scheduleReconnect.bind(this));
    }
  }

  scheduleReconnect() {
    if (this.desiredClosed) {
      return;
    }
    this.reconnectId = setTimeout(() => {
      if (this.socket.readyState !== Websocket.CLOSED) {
        return;
      }
      if (this.reconnections >= this.opts.maxReconnects) {
        log.info("reached max reconnection attempts for WebSocket client (%s)", this.name)
        return;
      }
      (async () => {
        try {
          log.info("Reconnecting to Websocket %s", this.name);
          this.reconnections += 1;
          this.socket = await this.connect();
        } catch (err) {
          log.error("Failed to reconnect to Websocket %s", this.name);
          this.scheduleReconnect();
        }
      })();
    }, this.opts.reconnectInterval)
  }

  close() {
    this.desiredClosed = true;
    clearTimeout(this.reconnectId);
    this.socket.close();
  }

  setSocketInfo = ({
    port,
    name
  }) => {
    if (port) this.port = port;
    if (name) this.name = name;
  }

  waitWsOpened(timeout = 1000): Promise<void> {
    log.debug(`Waiting for WebSocket client (%s) to be in 'CONNECTED' ready state...`, this.name);

    if (this.socket.readyState === 1) {
      return Promise.resolve(log.silly("WebSocket is already in CONNECTED ready state (%s)", this.socket.readyState));
    }

    return async_with_timeout(() => {
      return new Promise<void>((resolve, reject) => {
        const tid = setTimeout(() => {
          log.silly(`Checking ready state for WebSocket client (%s): %s`, this.name, this.socket.readyState);
          if (this.socket.readyState === 1)
            return resolve();

          log.silly("Triggering timeout for '%s' because ready state is not 'CONNECTED' within %sms", this.name, timeout);
          reject();
        }, timeout - 10);

        this.socket.once("open", () => {
          log.silly(`'open' event triggered on WebSocket client (%s)`, this.name);
          resolve();
          clearTimeout(tid);
        });
      });
    }, timeout);
  }

  waitWsClosed(timeout = 1000): Promise<void> {
    log.silly('waiting for WebSocket client %s to close', this.name);
    return async_with_timeout(() => {
      return new Promise<void>((resolve, reject) => {
        this.socket.once("close", () => {
          log.silly(`'close' event triggered on WebSocket client (%s)`, this.name);
          resolve();
        });
      });
    }, timeout);
  }
}
