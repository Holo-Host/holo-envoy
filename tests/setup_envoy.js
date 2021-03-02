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
const { config } = require('fetch-mock');


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

async function create_client({ mode, port, hha_hash, agent_id, web_user_legend, timeout }) {
  // NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
  const host_agent_id = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k' // log.info("Host Agent ID: %s", host_agent_id );

  const rawConfig = {
    "mode": mode || Chaperone.DEVELOP,
    "comb": false,
    "timeout": timeout || 50000,
    "debug": ["debug", "silly"].includes((process.env.LOG_LEVEL || "").toLowerCase()),
    "connection": {
      "host": "localhost",
      "port": port || envoy.ws_server.port,
      "secure": false,
      "path": "/hosting/"
    },
    "app_id": hha_hash || "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo",
    "host_agent_id": host_agent_id,
  };

  // note: web_user_legend and agent_id should not be provided simultaneously as opts
  let completeConfig;
  if (web_user_legend) {
    completeConfig = Object.assign({}, {
      "web_user_legend": web_user_legend
    }, rawConfig);
  } else if (agent_id) {
    completeConfig = Object.assign({}, {
      "agent_id": agent_id
    }, rawConfig);
  } else {
    completeConfig = rawConfig;
  }

  const client = new Chaperone(completeConfig);
  await client.ready(timeout);
  return client;
}


module.exports = {
  "client": create_client,
  "start": start_envoy,
  "stop": stop_envoy,
};
