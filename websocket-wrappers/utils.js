const async_with_timeout = require('./async_with_timeout.js');

const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

class ConnectionMonitor {
  constructor(client, connect, wsProtocol, {
    reconnectInterval,
    maxReconnects
  }) {
    this.socket = client.socket;
    this.connect = connect;
    this.wsProtocol = wsProtocol;
    this.name = '';
    this.port = null;
    this.closed = false;
    this.opts = {
      "reconnectInterval": reconnectInterval || null,
      "maxReconnects": maxReconnects || Infinity
    }
    this.reconnections = 0;
    if (this.opts.reconnectInterval !== null) {
      this.reconnectId = setInterval(this.tryReconnect.bind(this), reconnectInterval);
    }

    switch (this.wsProtocol) {
      case 'RPC':
        this.openListener = fn => this.on("open", fn);
        this.closeListener = fn => this.on("close", fn);
        break;

      case 'Holochain-WireMessage':
        this.openListener = fn => this.socket.onopen(fn);
        this.closeListener = fn => this.socket.onopen(fn);
        break;

      default:
        throw new Error('Unrecognized protocol for web client connections.');
    }

    this.closeListener(() => {
      this.closed = true;
    });
  }

  close () {
    clearTimeout(this.reconnectId);
    this.socket.close();
  }

  tryReconnect () {
    if (this.reconnections >= this.opts.maxReconnects) {
      log.info("reached max reconnection attempts for WebSocket client (%s)", this.name)
      clearInterval(this.reconnectId)
      return;
    }
    if (this.closed) {
      log.info("reconnecting to WebSocket client (%s)", this.name);
      this.closed = false;
      this.connect(this.socket.url);
      this.reconnections += 1;
    }
  }

  setSocketInfo = ({
    port,
    name
  }) => {
    if (port) this.port = port;
    if (name) this.name = name;
  }

  waitWsOpened(timeout = 1000) {
    log.debug(`Waiting for ${this.wsProtocol} WebSocket client (%s) to be in 'CONNECTED' ready state...`, this.name);

    if (this.socket.readyState === 1) {
      return Promise.resolve(log.silly("WebSocket is already in CONNECTED ready state (%s)", this.socket.readyState));
    }

    return async_with_timeout(() => {
      return new Promise((f, r) => {
        const tid = setTimeout(() => {
          log.silly(`Checking ready state for ${this.wsProtocol} WebSocket client (%s): %s`, this.name, this.socket.readyState);
          if (this.socket.readyState === 1)
            return f();

          log.silly("Triggering timeout for '%s' because ready state is not 'CONNECTED' within %sms", this.name, timeout);
          r();
        }, timeout - 10);

        this.openListener(() => {
          log.silly(`'open' event triggered on ${this.wsProtocol} WebSocket client (%s)`, this.name);
          f();
          clearTimeout(tid);
        });
      });
    }, timeout);
  }

  waitWsClosed(timeout = 1000) {
    log.silly('waiting for WebSocket client %s to close', this.name);
    return async_with_timeout(() => {
      return new Promise((f, r) => {
        this.closeListener(() => {
          log.silly(`'close' event triggered on ${this.wsProtocol} WebSocket client (%s)`, this.name);
          f();
        });
      });
    }, timeout);
  }
}
module.exports = ConnectionMonitor
