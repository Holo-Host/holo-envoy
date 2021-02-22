const async_with_timeout = require('./async_with_timeout.js');

const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
import { WsClient } from '@holochain/conductor-api/lib/websocket/client';
import Websocket from 'isomorphic-ws';
import EventEmitter from 'events';
import { time } from 'console';

export default class ConnectionMonitor extends EventEmitter {
  socket: Websocket | null = null;
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

  constructor(connect: () => Promise<Websocket>, {
    reconnectInterval,
    maxReconnects
  }) {
    super()
    this.connect = connect;
    this.opts = {
      "reconnectInterval": reconnectInterval ?? null,
      "maxReconnects": maxReconnects ?? Infinity
    }
    this.reconnections = 0;

    (async () => {
      try {
        this.socket = await this.connect();
        if (this.opts.reconnectInterval !== null) {
          this.socket.on("close", this.scheduleReconnect.bind(this));
        }
      } catch (err) {
        log.error("Failed to connect to Websocket %s", this.name);
        if (this.opts.reconnectInterval !== null) {
          this.scheduleReconnect();
        }
      }
    })();
  }

  scheduleReconnect() {
    if (this.desiredClosed) {
      return;
    }
    this.reconnectId = setTimeout(() => {
      if (this.socket !== null && this.socket.readyState !== Websocket.CLOSED) {
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
          this.socket.on("close", this.scheduleReconnect.bind(this));
          this.socket.on("open", (...args) => this.emit("open", ...args))
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

  waitWsOpened(timeout: number | null = 1000): Promise<void> {
    log.debug(`Waiting for WebSocket client (%s) to be in 'CONNECTED' ready state...`, this.name);

    if (this.socket !== null && this.socket.readyState === 1) {
      return Promise.resolve(log.silly("WebSocket is already in CONNECTED ready state (%s)", this.socket.readyState));
    }

    const openPromise = new Promise<void>((resolve, reject) => {
      this.once("open", () => {
        log.silly(`'open' event triggered on WebSocket client (%s)`, this.name);
        resolve();
      });
    });

    if (timeout !== null) {
      return async_with_timeout(() => {
        return openPromise;
      }, timeout);
    }
    return openPromise;
  }

  waitWsClosed(timeout: number | null = 1000): Promise<void> {
    log.silly('waiting for WebSocket client %s to close', this.name);
    const closePromise = new Promise<void>((resolve, reject) => {
      this.socket.once("close", () => {
        log.silly(`'close' event triggered on WebSocket client (%s)`, this.name);
        resolve();
      });
    });
    if (timeout !== null) {
      return async_with_timeout(() => {
        return closePromise;
      }, timeout);
    }
    return closePromise;
  }
}
