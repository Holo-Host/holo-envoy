const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'silly',
});
const {
  Codec
} = require('@holo-host/cryptolib');

const uuid = require('uuid');
const {
  v4: uuidv4
} = uuid;
const { resetTmp, delay } = require("../utils");
const expect = require('chai').expect;
const fetch = require('node-fetch');
const setup_conductor = require("../setup_conductor.js");
const setup = require("../setup_envoy.js");

const AGENT_ID = "uhCAkkeIowX20hXW-9wMyh0tQY5Y73RybHi1BdpKdIdbD26Dl_xwq";

describe("Server", () => {

  let envoy;
  let server;
  let client;

  before(async function() {
    this.timeout(40_000);

    log.info("Waiting for Lair to spin up");
    setup_conductor.start_lair()
    await delay(10000);

    envoy = await setup.start();
    server = envoy.ws_server;

    log.info("Waiting for Conductor to spin up");
    setup_conductor.start_conductor()
    await delay(10000);

    log.info("Waiting for Conductor connections...");
    await envoy.connected;

    client = await setup.client({
      agent_id: AGENT_ID
    });
  });
  after(async function() {
    this.timeout(60_000);

    log.debug("Stop holochain...");
    await setup_conductor.stop_conductor();

    log.info("Closing client...");
    client && await client.close();

    log.info("Stopping Envoy...");
    await setup.stop();

    await resetTmp();
  });

  const channel_args = {
    category: "General"
  }

  it.skip("should process request and respond", async () => {
    try {
      conductor.general.once("call", async function(data) {
        const keys = Object.keys(data);

        expect(keys.length).to.equal(4);
        expect(data["cell_id"]).to.equal([Codec.HoloHash.holoHashFromBuffer('header', Codec.HoloHash.decode("uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"))]);
        expect(data["zome"]).to.equal("chat");
        expect(data["function"]).to.equal("list_channels");
        expect(data["args"]).to.be.an("object");
        expect(data["args"]).to.equal(channel_args);

        return [];
      });

      const response = await client.callZomeFunction("elemental-chat", "chat", "list_channels", channel_args);
      log.debug("Response: %s", response);

      expect(response).to.deep.equal([]);
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

        return true;
      });

      try {
        await client.callZomeFunction("elemental-chat", "chat", "list_channels", channel_args);
      } catch (err) {
        failed = true;
        expect(err.name).to.include("HoloError");
        expect(err.message).to.include("not signed-in");
      }

      expect(failed).to.be.true;
    } finally {}
  });

  it.skip("should fail to sign-in because this host doesn't know this Agent", async () => {
    try {
      let failed = false;
      try {
        await client.signIn("someone@example.com", "Passw0rd!");
      } catch (err) {
        failed = true;

        expect(err.name).to.include("HoloError");
        expect(err.message).to.include("unknown to this Host");
      }

      expect(failed).to.be.true;
    } finally {}
  });

  it.skip("should sign-up on this Host", async function() {
    this.timeout(5_000);
    try {
      await client.signUp("someone@example.com", "Passw0rd!");

      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal(AGENT_ID);
    } finally {}
  });

  it.skip("should sign-out", async () => {
    try {
      await client.signOut();

      expect(client.anonymous).to.be.true;
      expect(client.agent_id).to.not.equal(AGENT_ID);
    } finally {}
  });

  it.skip("should fail capability signing of zome-call because wormhole is closed", async function() {
    this.timeout(30_000);

    let failed = false;
    const fail_client = await setup.client();
    try {
      await fail_client.signUp("wormhole@example.com", "Passw0rd!");

      const agent_id = fail_client.agent_id;
      expect(agent_id).to.equal("uhCAkTFYCB48/Bx/QvKQPVSuXAV8sLHKJXrh6ZS8YVe2MdsvSgc7q");

      fail_client.conn.removeAllListeners("uhCAkTFYCB48/Bx/QvKQPVSuXAV8sLHKJXrh6ZS8YVe2MdsvSgc7q/wormhole/request");
      await fail_client.callZomeFunction("elemental-chat", "chat", "create_channel", {
        "name": "The Social Room",
        "channel": {
          category: "General",
          uuid: uuidv4()
        }
      });
    } catch (err) {
      failed = true;

      expect(err.message).to.have.string("Caller does not have Capability to make that call");
    } finally {
      fail_client.close();
    }

    expect(failed).to.be.true;
  });

  it.skip("should process signed-in request and respond", async function() {
    this.timeout(60_000);
    try {
      let check = await client.signIn("someone@example.com", "Passw0rd!");
      expect(check).be.true;
      const agent_id = client.agent_id;

      expect(agent_id).to.equal(AGENT_ID);

      const response = await client.callZomeFunction("elemental-chat", "chat", "list_channels", channel_args);
      log.debug("Response: %s", response);

      expect(response).to.be.an("object");
      expect(Object.keys(response[0])).to.have.members(["channel", "info", "latest_chunk"]);
    } finally {}
  });

  function delay(t, val) {
    return new Promise(function(resolve) {
      setTimeout(function() {
        resolve(val);
      }, t);
    });
  }

  it("should have no pending confirmations", async function() {
    this.timeout(5_000);
    try {
      // Give confirmation request some time to finish
      await delay(2_000);

      expect(envoy.pending_confirms).to.be.empty;
      expect(client.pending_confirms).to.be.empty;
    } finally {}
  });

});
