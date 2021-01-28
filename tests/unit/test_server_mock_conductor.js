const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const expect = require('chai').expect;
const fetch = require('node-fetch');
const why = require('why-is-node-running');

const setup = require("../setup_envoy.js");
const MockConductor = require('@holo-host/mock-conductor');
const {
  ZomeAPIResult
} = MockConductor;

describe("Server with mock Conductor", () => {
  const MASTER_PORT = 4444;
  const SERVICE_PORT = 42222;
  const INTERNAL_PORT = 42233;
  const HOSTED_PORT = 42244;
  const INTERNAL_INSTALLED_APP_ID = "holo-hosting-app"
  // Note: The value used for the hosted installed_app_ids
  // ** must match the hha_hash pased to the chaperone server (in setup_envoy.js)
  const HOSTED_INSTALLED_APP_ID = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
  const SERVICE_INSTALLED_APP_ID = `${HOSTED_INSTALLED_APP_ID}::servicelogger`
  const DNA_ALIAS = "dna_alias";
  const MOCK_CELL_ID = [Buffer.from("dnaHash"), Buffer.from("agentPubkey")];
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
  hosted_port_number: 0,
  hosted_app: {
    // servicelogger_id: SERVICE_INSTALLED_APP_ID,
    dnas: [{
      nick: 'test-hha',
			path: './dnas/elemental-chat.dna.gz',
		}],
		usingURL: false
  }
}

  before("Start mock conductor with envoy and client", async () => {
    adminConductor = new MockConductor(MASTER_PORT);
    serviceConductor = new MockConductor(SERVICE_PORT);
    internalConductor = new MockConductor(INTERNAL_PORT);
    hostedConductor = new MockConductor(HOSTED_PORT);

    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;
    // wormhole			= envoy.wormhole;

    log.info("Waiting for Conductor connections...");
    await envoy.connected;
  });
  beforeEach('Set-up installed_app_ids for test', async () => {
    internalConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: INTERNAL_INSTALLED_APP_ID}, { cell_data: MOCK_CELL_DATA })
    hostedConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: HOSTED_INSTALLED_APP_ID}, { cell_data: MOCK_CELL_DATA })
    serviceConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: SERVICE_INSTALLED_APP_ID}, { cell_data: MOCK_CELL_DATA })
  });
  afterEach("Close client", async () => {
    log.info("Closing client...");
    await client.close();
  });
  after("Close mock conductor with envoy", async () => {
    log.info("Stopping Envoy...");
    await setup.stop();

    log.info("Stopping Conductor...");
    await adminConductor.close();
    await serviceConductor.close();
    await internalConductor.close();
    await hostedConductor.close();
  });

  it("should process request and respond", async () => {
    client = await setup.client({
      web_user_legend : {
        "alice.test.1@holo.host": "uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq",
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
      hostedConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);

      const servicelogData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "service",
        fn_name: "log_activity",
        args: {
          zomeFnArgs: "Activity Log"
        }
      };
      const activity_log_response = 'Activity Log Success Hash';
      serviceConductor.once(MockConductor.ZOME_CALL_TYPE, servicelogData, activity_log_response);

      const response = await client.callZomeFunction("dna_alias", "zome", "zome_fn", {
        zomeFnArgs: "String Input"
      });

      log.debug("Response: %s", response);
      expect(response).to.equal("Hello World");
    } finally {}
  });

  it("should sign-up on this Host", async () => {
    const agentId = "uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq";
    client = await setup.client({
      agent_id: agentId
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
      internalConductor.once(MockConductor.ZOME_CALL_TYPE, hhaData, happ_bundle_details_response);

      const appInfo = {
        installed_app_id: HOSTED_INSTALLED_APP_ID,
        agent_key: Buffer.from(agentId),
        dnas: envoyOpts.hosted_app.dnas,
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, { type: "success" });
      adminConductor.once(MockConductor.ACTIVATE_APP_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, { type: "success" });
      adminConductor.once(MockConductor.ATTACH_APP_INTERFACE_TYPE, { port: 0 }, { type: "success" });

      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal("uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq");
    } finally {}
  });

  it("should sign-out", async () => {
    client = await setup.client({
      agent_id: "uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq"
    });
    try {
      await client.signOut();

      expect(client.anonymous).to.be.true;
      expect(client.agent_id).to.not.equal("HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi");
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
});
