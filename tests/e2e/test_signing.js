const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const fs = require('fs');
const yaml = require('js-yaml');
const { delay, resetTmp } = require('../utils.js');
const expect = require('chai').expect;
const {
  structs,
  ...lair
} = require('@holochain/lair-client');
const msgpack = require('@msgpack/msgpack');
const {
  AppWebsocket
} = require('@holochain/conductor-api');
const setup_conductor = require("../setup_conductor.js");
const { Codec, KeyManager } = require('@holo-host/cryptolib');
const { init } = require("../../src/shim.js");
const crypto = require('crypto')
const WH_SERVER_PORT = path.resolve(__dirname, '../../script/install-bundles/shim/socket');
const LAIR_SOCKET = path.resolve(__dirname, '../../script/install-bundles/keystore/socket');
const installedAppIds = yaml.load(fs.readFileSync('./script/app-config.yml'));
// NOTE: the test app servicelogger installed_app_id is hard-coded, but intended to mirror our standardized installed_app_id naming pattern for each servicelogger instance (ie:`${hostedAppHha}::servicelogger`)
const HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID = installedAppIds[0].app_name;

describe("Wormhole tests", () => {
  let shim, appWs, seed, keys, slCellId;
  before(async function() {
    this.timeout(100_000);

    log.info("Waiting for Lair to spin up");
    await setup_conductor.start_lair()
    await delay(5000);
    seed = crypto.randomBytes(32);
    keys = new KeyManager(seed);
    shim = await init(LAIR_SOCKET, WH_SERVER_PORT, async function(pubkey, message) {
      return null;
    });
    await delay(5000);

    log.info("Waiting for Conductor to spin up");
    await setup_conductor.start_conductor()
    await delay(10000);

    appWs = await AppWebsocket.connect('ws://localhost:42233')
    slCellId = await setUpServicelogger(appWs)

  });
  after(async () => {
    await shim.stop();
    await setup_conductor.stop_conductor();
    await resetTmp();
  });

  it("test shim signing for zome call", async () => {
    console.log("Getting payload...");
    const payload = await getPayload(keys);
    console.log("Calling zome log_activity...");
    try {
      loggedActivity = await appWs.callZome({
        cell_id: [Buffer.from(slCellId[0]), Buffer.from(slCellId[1])],
        zome_name: 'service',
        fn_name: 'log_activity',
        payload,
        cap: null,
        provenance: Buffer.from(slCellId[1])
      });
      expect(loggedActivity).to.be.ok
    } catch(e) {
      console.log("Failing...", e);
      expect(false).to.be.ok
    }
  });

});

const sign = (keys, data) => {
  let msg_bytes = msgpack.encode(data)
  const sig_bytes = keys.sign(msg_bytes);
  return sig_bytes
}

async function getPayload(keys) {
  let request_payload = {
    call_spec: {
      args_hash: "uhCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv",
      function: "get_message",
      zome:"chat",
      dna_alias: "element-chat",
      hha_hash: "uhCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv"
    },
    host_id: "d5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k",
    timestamp: [162303,0]
  }

  let request = {
    agent_id: Codec.AgentId.encode(keys.publicKey()),
    request: request_payload,
    request_signature: await sign(keys, request_payload)
  }

  let response_payload = "kRW1wN0luUmxjM1FpT2lKcGJtWnZjbTFoZEdsdmJpSXNJblJvYVhNaU9uc2liblZ0WW1WeUlqb3hMQ0ozYVd4c0lqcGJJbUpsSUd"
  let response = {
    response_hash: response_payload,
    host_metrics: {
      cpu: 7,
      bandwidth: 1
    },
    signed_response_hash: await sign(keys, response_payload),
    weblog_compat: {
      source_ip: "100:0:0:0",
      status_code: 200
    }
  }

  let confirmation_payload = {
    response_digest: "JblJvYVhNaU9uc2liblZ0WW1WeUlqb",
    metrics: {
      response_received: [165303,0]
    }
  }
  let confirmation = {
    confirmation: confirmation_payload,
    confirmation_signature: await sign(keys, confirmation_payload)
  }
  return {
    request,
    response,
    confirmation
  }
}

async function setUpServicelogger(appWs) {
    let serviceloggerCellId;
    try {
      const serviceloggerAppInfo = await appWs.appInfo({
        installed_app_id: HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID
      });
      serviceloggerCellId = serviceloggerAppInfo.cell_data[0][0];
    } catch (error) {
      throw new Error(`Failed to get appInfo: ${JSON.stringify(error)}`);
    }
    let payload = {
      provider_pubkey: Codec.AgentId.encode(serviceloggerCellId[1]),
      max_fuel_before_invoice: 3,
      price_compute: 1,
      price_storage: 1,
      price_bandwidth: 1,
      max_time_before_invoice: [604800, 0]
    }
    try {
      logger_settings = await appWs.callZome({
        cell_id: [Buffer.from(serviceloggerCellId[0]), Buffer.from(serviceloggerCellId[1])],
        zome_name: 'service',
        fn_name: 'set_logger_settings',
        payload,
        cap: null,
        provenance: Buffer.from(serviceloggerCellId[1])
      });
      return serviceloggerCellId
    } catch (error) {
      console.log("Error?:", error);
      throw new Error(`Failed to set logger settings: ${error}`);
    }
}
