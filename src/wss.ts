import path from 'path';
import logger from '@whi/stdlog';

const log = logger(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const RPCWebSocketServer = require('rpc-websockets').Server;
class WebSocketServer extends RPCWebSocketServer {

  port: number;
  clients: any = [];
  client_counter: number = 0;

  constructor(...args) {
    super(...args);
    const options = args[0] || {};

    this.port = options.port;
    this.log_prefix = `RPC WebSocket server 0.0.0.0:${this.port} >> `;

    log.info(this.log_prefix + "Starting RPC WebSocket server on port %s", this.port);
  }

  register(method, fn, ns) {
    log.debug(this.log_prefix + "Registering method '%s' in namespace: %s", method, ns);
    return super.register(method, async function(...args) {
      try {
        return await fn.apply(this, args);
      } catch (err) {
        log.error("Handler '%s' threw an error: %s", method, String(err));
        throw err;
      }
    }, ns);
  }

  unregister(name, ns = "/") {
    log.debug(this.log_prefix + "Unregistering method '%s' in namespace: %s", name, ns);
    delete this.namespaces[ns].rpc_methods[name];
  }

  once(method, handler, ns) {
    log.info(this.log_prefix + "Registering single-use method '%s' in namespace: %s", method, ns);
    const self = this;
    this.register(method, async function(...args) {
      self.unregister(method);
      return await handler.apply(this, args);
    }, ns);
  }

  async close() {
    log.debug(this.log_prefix + "Closing %s client(s)", this.clients.length);
    for (let [i, rws] of this.clients.entries()) {
      const ws = rws.socket;

      log.silly(this.log_prefix + "Closing websocket client[%s]: ready state %s", ws.id, ws.readyState);
      rws.close();

      await rws.closed();
      log.silly(this.log_prefix + "Client %s is closed: ready state %s", ws.readyState);
    }

    log.debug(this.log_prefix + "Closing server");
    return super.close();
  }

}

export default WebSocketServer;
export {
  WebSocketServer as Server,
}
