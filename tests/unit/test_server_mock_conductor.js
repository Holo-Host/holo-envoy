const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const expect = require('chai').expect;
const fetch = require('node-fetch');
const why = require('why-is-node-running');
const portscanner = require('portscanner');

const setup = require("../setup_envoy.js");
const MockConductor = require('@holo-host/mock-conductor');
const { Codec } = require('@holo-host/cryptolib');

const {
  ZomeAPIResult
} = MockConductor;

describe("Server with mock Conductor", () => {
  const ADMIN_PORT = 4444;
  const FAKE_PORT = 666;
  const APP_PORT = 42233;
  const INTERNAL_INSTALLED_APP_ID = "holo-hosting-app"
  // Note: The value used for the hosted installed_app_ids
  // ** must match the hha_hash pased to the chaperone server (in setup_envoy.js)
  const HOSTED_INSTALLED_APP_ID = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
  const SERVICE_INSTALLED_APP_ID = `${HOSTED_INSTALLED_APP_ID}::servicelogger`
  const DNA_ALIAS = "dna_alias";
  const AGENT_ID = "uhCAkkeIowX20hXW-9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl_xwq";
  const DNA_HASH = "uhCEkWCsAgoKkkfwyJAglj30xX_GLLV-3BXuFy436a2SqpcEwyBzm";
  const MOCK_CELL_ID = [Codec.AgentId.decode(DNA_HASH), Codec.AgentId.decode(AGENT_ID)];
  const MOCK_CELL_DATA = [[MOCK_CELL_ID, DNA_ALIAS]];

  let envoy;
  let server;
  let conductor;
  // let wormhole;
  let client;


  const envoy_mode_map = {
    production: 0,
    develop: 1,
  }

  const envoyOpts = {
    mode: envoy_mode_map.develop,
    app_port_number: 0,
    hosted_app: {
      // servicelogger_id: SERVICE_INSTALLED_APP_ID,
      dnas: [{
        nick: 'test-hha',
        path: './dnas/elemental-chat.dna.gz',
      }],
      usingURL: false
    }
  }

  async function checkPorts(port_array) {
    return new Promise((resolve, reject) => {
      portscanner.findAPortInUse(port_array, '127.0.0.1', function(error, port) {
        if (port) {
          reject(new Error(`Port ${port} already used by other process`));
        }
        resolve();
      });
    });
  }

  before("Start mock conductor with envoy and client", async () => {
    await checkPorts([ADMIN_PORT, FAKE_PORT, APP_PORT]);

    // FAKE_PORT is used in appConducotr because of the way MockConductor works:
    // 1st arg is Admin port that does not receive signals
    adminConductor = new MockConductor(ADMIN_PORT);
    appConductor = new MockConductor(FAKE_PORT, APP_PORT);

    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;
    // wormhole			= envoy.wormhole;

    log.info("Waiting for Conductor connections...");
    await envoy.connected;
  });
  beforeEach('Set-up installed_app_ids for test', async () => {
    appConductor.any({ cell_data: MOCK_CELL_DATA })
  });
  afterEach("Close client", async () => {
    log.info("Closing client...");
    if (client) await client.close();
  });
  after("Close mock conductor with envoy", async () => {
    log.info("Stopping Envoy...");
    await setup.stop();

    log.info("Stopping Conductor...");
    await adminConductor.close();
    await appConductor.close();
  });
/*
  it("should encode and decode back agent id", async () => {
    let result = Codec.AgentId.encode(Codec.AgentId.decode(AGENT_ID));
    expect(result).to.equal(AGENT_ID);
  });

  it("should process request and respond", async () => {
    client = await setup.client({
      web_user_legend : {
        "alice.test.1@holo.host": AGENT_ID,
      }
    });

    try {
      const callZomeData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "zome",
        fn_name: "zome_fn",
        args: {
          zomeFnArgs: "String Input"
        }
      };
      const expected_response = "Hello World";
      appConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);

      const servicelogData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "service",
        fn_name: "log_activity",
        args: {
          zomeFnArgs: "Activity Log"
        }
      };
      const activity_log_response = 'Activity Log Success Hash';
      appConductor.once(MockConductor.ZOME_CALL_TYPE, servicelogData, activity_log_response);

      const response = await client.callZomeFunction("dna_alias", "zome", "zome_fn", {
        zomeFnArgs: "String Input"
      });

      log.debug("Response: %s", response);
      expect(response).to.equal("Hello World");
    } finally {}
  });
*/
  it("should sign-up on this Host", async () => {
    client = await setup.client({
      agent_id: AGENT_ID
    });
    client.skip_assign_host = true;

    try {
      const hhaData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "hha",
        fn_name: "get_happ",
        args: {
          zomeFnArgs: "happ bundle info"
        }
      };
      const happ_bundle_details_response = {
        happ_id: Buffer.from('HeaderHash'),
        happ_bundle: {
          hosted_url: 'http://holofuel.holohost.net',
          happ_alias: 'holofuel-console',
          ui_path: 'path/to/compressed/ui/file',
          name: 'HoloFuel Console',
          dnas: [{
            hash: 'uhCkk...',
            path: '/path/to/compressed/dna/file',
            nick: 'holofuel'
          }],
        },
        provider_pubkey: Buffer.from('AgentPubKey'),
      };
      appConductor.once(MockConductor.ZOME_CALL_TYPE, hhaData, happ_bundle_details_response);

      const appInfo = {
        installed_app_id: HOSTED_INSTALLED_APP_ID,
        agent_key: Codec.AgentId.decode(AGENT_ID),
        dnas: envoyOpts.hosted_app.dnas,
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, { type: "success" });
      adminConductor.once(MockConductor.ACTIVATE_APP_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, { type: "success" });
      adminConductor.once(MockConductor.ATTACH_APP_INTERFACE_TYPE, { port: 0 }, { type: "success" });

      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal(AGENT_ID);
    } finally {}
  });

  it("should forward signal from conductor to client", async () => {
    let expectedSignalData = "Hello signal!";
    // Instance of DNA that is emitting signal
    // has to match DNA registered in envoy's dna2hha during Login and agent's ID
    let cellId = MOCK_CELL_ID;

    client = await setup.client({
      agent_id: AGENT_ID
    });
    client.skip_assign_host = true;

    try {
      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      // mock conductor emits signal (has to be the right one)
      log.debug(`Broadcasting signal via mock conductor`);
      await appConductor.broadcastAppSignal(cellId, expectedSignalData);

      // wait for signal to propagate all across
      await delay(1500)

      // client receives this
      let receivedSignalData = client.signalStore;

      expect(receivedSignalData).to.equal(expectedSignalData);
    } finally {}
  });
/*
  it("should sign-out", async () => {
    client = await setup.client({
      agent_id: AGENT_ID
    });
    try {
      await client.signOut();

      expect(client.anonymous).to.be.true;
      expect(client.agent_id).to.not.equal(AGENT_ID);
    } finally {}
  });

  it.skip("should complete wormhole request", async () => {
    client = await setup.client();
    try {
      conductor.general.once("call", async function(data) {
        const signature = await conductor.wormholeRequest(client.agent_id, "UW1ZVWo1NnJyakFTOHVRQXpkTlFoUHJ3WHhFeUJ4ZkFxdktwZ1g5bnBpOGZOeA==");

        expect(signature).to.equal("w/lyO2IipA0sSdGtbg+5pACLoafOkdPRXXuiELis51HVthfhzdP2JZeIDQkwssMccC67mHjOuYsALe5DPQjKDw==");

        return ZomeAPIResult(true);
      });

      const response = await client.callZomeFunction("elemental-chat", "chat", "list_channels", {
        category: "General"
      });
      log.debug("Response: %s", response);

      expect(response).to.be.true;
    } finally {}
  });

  it.skip("should fail wormhole request because Agent is anonymous", async () => {
    client = await setup.client();
    try {

      let failed = false;
      conductor.general.once("call", async function(data) {
        await conductor.wormholeRequest(client.agent_id, {
          "some": "entry",
          "foo": "bar",
        });

        return ZomeAPIResult(true);
      });

      try {
        await client.callZomeFunction("elemental-chat", "chat", "list_channels", {
          category: "General"
        });
      } catch (err) {
        failed = true;
        expect(err.name).to.include("HoloError");
        expect(err.message).to.include("not signed-in");
      }

      expect(failed).to.be.true;
    } finally {}
  });

  it("should have no pending confirmations", async () => {
    try {
      expect(envoy.pending_confirms).to.be.empty;
    } finally {}
  });
*/
  it("should fail to sign-up because conductor disconnected");
  it("should fail to sign-up because admin/agent/add returned an error");
  it("should fail to sign-up because HHA returned an error");
  it("should fail to sign-up because Happ Store returned an error");
  it("should fail to sign-up because adminInterface call, `installApp`, returned an error");
  it("should fail to sign-up because adminInterface call, `activateApp`, returned an error");
  it("should fail to sign-up because adminInterface call, `attachAppInterface`, returned an error");
  it("should fail to sign-in because this host doesn't know this Agent");
  it("should handle obscure error from Conductor");
  it("should disconnect Envoy's websocket clients on conductor disconnect");

  function delay(t) {
    return new Promise(function(resolve) {
      setTimeout(function() {
        resolve();
      }, t);
    });
  }
});
