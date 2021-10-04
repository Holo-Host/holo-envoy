const path = require('path');

const expect = require('chai').expect;
const {
  AdminWebsocket,
  AppWebsocket
} = require('@holochain/conductor-api');

const setup_conductor = require("../setup_conductor.js");
const { init } = require("../../src/shim.js");
const installHapps = require('../install_happs.js');
const SHIM_SOCKET = path.resolve(__dirname, '..', 'tmp', 'shim', 'socket');
const LAIR_SOCKET = path.resolve(__dirname, '..', 'tmp', 'keystore', 'socket');

describe("Wormhole tests", () => {
  let shim, appWs, testCellId;
  before(async function() {
    this.timeout(100_000);

    await setup_conductor.start({
      setup_shim: () => {
        shim = init(LAIR_SOCKET, SHIM_SOCKET, function(pubkey, message) {
          console.log("Test shim...");
          return null;
        });

        return {
          kill_shim: async () => await (await shim).stop()
        }
      }
    })

    const adminWs = await AdminWebsocket.connect("ws://localhost:4444/")

    const happs = await installHapps(adminWs)
    testCellId = happs.test.cell_data[0].cell_id

    await adminWs.attachAppInterface({ port: 42244 })
    appWs = await AppWebsocket.connect('ws://localhost:42244')
  });
  after(async () => {
    await setup_conductor.stop()
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
