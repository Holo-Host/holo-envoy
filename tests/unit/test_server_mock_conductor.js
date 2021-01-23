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
  const APP_ID = "happ-name";
  const DNA_ALIAS = "dna_alias";
  const MOCK_CELL_ID = ["dnaHash", "agentPubkey"];
  const MOCK_CELL_DATA = [[MOCK_CELL_ID, DNA_ALIAS]];

  let envoy;
  let server;
  let conductor;
  // let wormhole;
  let client;

  before("Start mock conductor with envoy and client", async () => {
    adminConductor = new MockConductor(MASTER_PORT);
    serviceConductor = new MockConductor(SERVICE_PORT);
    internalConductor = new MockConductor(INTERNAL_PORT);
    hostedConductor = new MockConductor(HOSTED_PORT);

    adminConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: APP_ID}, { cell_data: MOCK_CELL_DATA })
    serviceConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: APP_ID}, { cell_data: MOCK_CELL_DATA })
    internalConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: APP_ID}, { cell_data: MOCK_CELL_DATA })
    hostedConductor.once(MockConductor.APP_INFO_TYPE, {installed_app_id: APP_ID}, { cell_data: MOCK_CELL_DATA })

    envoy = await setup.start();
    server = envoy.ws_server;
    // wormhole			= envoy.wormhole;

    log.info("Waiting for Conductor connections...");
    await envoy.connected;

    client = await setup.client(HOSTED_PORT);
  });
  after("Close mock conductor with envoy and client", async () => {
    log.info("Closing client...");
    await client.close();

    log.info("Stopping Envoy...");
    await setup.stop();

    log.info("Stopping Conductor...");
    await adminConductor.close();
    await serviceConductor.close();
    await internalConductor.close();
    await hostedConductor.close();
  });

  it.only("should process request and respond", async () => {
    try {
      const callZomeData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "chat",
        fn_name: "list_channels",
        args: {
          category: "General"
        }
      };

      const expected_response = "Hello World";
      hostedConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);
      const response = await client.callZomeFunction("elemental-chat", "chat", "list_channels", {
        category: "General"
      });

      log.debug("Response: %s", response);

      expect(response).to.equal("Hello World");
    } finally {}
  });

  it("should sign-up on this Host", async () => {
    try {
      await client.signUp("someone@example.com", "Passw0rd!");

      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal("uhCAkkeIowX20hXW+9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl/xwq");
    } finally {}
  });

  it("should sign-out", async () => {
    try {
      await client.signOut();

      expect(client.anonymous).to.be.true;
      expect(client.agent_id).to.not.equal("HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi");
    } finally {}
  });

  it.skip("should process signed-in request and respond", async () => {
    try {
      await client.signIn("someone@example.com", "Passw0rd!");
      const agent_id = client.agent_id;
      
      const callZomeData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "chat",
        fn_name: "list_channels",
        args: {
          category: "General"
        }
      };
      
      const expected_response = [];
      
      hostedConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);

      const response = await client.callZomeFunction("elemental-chat", "chat", "list_channels", {
        category: "General"
      });
      log.debug("Response: %s", response);

      expect(response).to.deep.equal([]);
    } finally {}
  });

  it.skip("should complete wormhole request", async () => {
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