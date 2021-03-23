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
const INSTALLED_APP_ID = installedAppIds[2].app_name;

describe("Wormhole tests", () => {
  let shim, appWs, seed, keys, testCellId;
  before(async function() {
    this.timeout(100_000);
    await setup_conductor.setup_conductor()
    log.info("Waiting for Lair to spin up");
    await setup_conductor.start_lair()
    await delay(5000);
    shim = await init(LAIR_SOCKET, WH_SERVER_PORT, async function(pubkey, message) {
      console.log("Test shim...");
      return null;
    });
    await delay(5000);

    log.info("Waiting for Conductor to spin up");
    await setup_conductor.start_conductor()
    await delay(10000);
    appWs = await AppWebsocket.connect('ws://localhost:42233')
    testCellId = await getTestCellID(appWs)
  });
  after(async () => {
    await shim.stop();
    await setup_conductor.stop_conductor();
    await setup_conductor.stop_lair();
    await resetTmp();
  });

  it("test shim signing for zome call", async () => {
    console.log("Calling zome test...", testCellId);
    try {
      response = await appWs.callZome({
        cell_id: [Buffer.from(testCellId[0]), Buffer.from(testCellId[1])],
        zome_name: 'test',
        fn_name: 'returns_obj',
        payload: null,
        cap: null,
        provenance: Buffer.from(testCellId[1])
      });
      console.log("return from signing test: ", response);
      expect(response).to.be.ok
    } catch(e) {
      console.log("Failing...", e);
      expect(false).to.be.ok
    }
  });

});

async function getTestCellID(appWs) {
    try {
      const testAppInfo = await appWs.appInfo({
        installed_app_id: INSTALLED_APP_ID
      }, 1000);
      return testAppInfo.cell_data[0].cell_id;
    } catch (error) {
      throw new Error(`Failed to get appInfo: ${error}`);
    }
}
