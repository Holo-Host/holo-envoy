const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const fs = require('fs');
const {
  Codec
} = require("@holo-host/cryptolib");

const {
  Envoy
} = require("../build/index.js");
const {
  Chaperone
} = require("./setup_chaperone.js");


let envoy;
const clients = [];

async function start_envoy(opts = {}) {
  envoy = new Envoy(opts);
  return envoy;
}

async function stop_envoy() {
  for (let [i, client] of clients.entries()) {
    const ws = client.websocket();

    log.debug("Closing Chaperone client[%s]: %s", i, ws.url);
    await client.close();
  }

  log.debug("Closing Envoy...");
  await envoy.close();
}

async function create_client(port = envoy.ws_server.port,
  mode = Chaperone.DEVELOP,
  agent_id = "uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq",
  hha_hash = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo",
  timeout = 50000) {

  // NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
  const host_agent_id = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k' // log.info("Host Agent ID: %s", host_agent_id );

  const client = new Chaperone({
    "mode": mode,
    "comb": false,
    "timeout": timeout,
    "debug": ["debug", "silly"].includes((process.env.LOG_LEVEL || "").toLowerCase()),
    "connection": {
      "host": "localhost",
      "port": port,
      "secure": false,
      "path": "/"
    },
    "agent_id": agent_id,
    "app_id": hha_hash,
    "host_agent_id": host_agent_id,
  });

  await client.ready(timeout);

  return client;
}


module.exports = {
  "client": create_client,
  "start": start_envoy,
  "stop": stop_envoy,
};