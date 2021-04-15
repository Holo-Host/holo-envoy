const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const fs = require('fs');
const yaml = require('js-yaml');
const expect = require('chai').expect;
const puppeteer = require('puppeteer');
const http_servers = require('../setup_http_server.js');
const setup = require("../setup_envoy.js");
const setup_conductor = require("../setup_conductor.js");
const { Codec } = require('@holo-host/cryptolib');
const { create_page, fetchServiceloggerCellId, setupServiceLoggerSettings, PageTestUtils, envoy_mode_map, resetTmp, delay } = require("../utils")
const msgpack = require('@msgpack/msgpack');

const INVALID_JOINING_CODE = msgpack.encode('failing joining code').toString('base64')
const SUCCESSFUL_JOINING_CODE = msgpack.encode('joining code').toString('base64')

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const host_agent_id = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k'

log.info("Host Agent ID: %s", host_agent_id);

// Note: All envoyOpts.dnas will be registered via admin interface with the paths provided here
const envoyOpts = {
  mode: envoy_mode_map.develop,
}

const REGISTERED_HAPP_HASH = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"

describe("Server", () => {
  let envoy, server, browser
  let http_ctrls, http_url, page;

  before(async function() {
    this.timeout(100_000);

    log.info("Waiting for Lair to spin up");
    setup_conductor.start_lair()
    await delay(10000);

    log.info("Starting Envoy");
    // Note: envoy will try to connect to the conductor but the conductor is not started so it needs to retry
    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;

    log.info("Waiting for Conductor to spin up");
    setup_conductor.start_conductor()
    await delay(10000);

    log.info("Waiting to connect to Conductor");
    await envoy.connected;

    log.info("Envoy Connected");

    http_ctrls = http_servers();
    browser = await puppeteer.launch();
    log.debug("Setup config: %s", http_ctrls.ports);
    http_url = `http://localhost:${http_ctrls.ports.chaperone}`;
  
    const page_url = `${http_url}/html/chaperone.html`
    page = await create_page(page_url, browser);
    const pageTestUtils = new PageTestUtils(page)

    pageTestUtils.logPageErrors();
    pageTestUtils.describeJsHandleLogs();

    await page.exposeFunction('delay', delay)

    // Set logger settings for hosted app (in real word scenario - will be done when host installs app):
    try {
      const servicelogger_cell_id = await fetchServiceloggerCellId(envoy.hcc_clients.app);
      console.log("Found servicelogger cell_id: %s", servicelogger_cell_id);
      // NOTE: The host settings must be set prior to creating a service activity log with servicelogger (eg: when making a zome call from web client)
      const logger_settings = await setupServiceLoggerSettings(envoy.hcc_clients.app, servicelogger_cell_id);
      console.log("happ service preferences set in servicelogger as: %s", logger_settings);
    } catch (err) {
      console.log(typeof err.stack, err.stack.toString());
      throw err;
    }
  });

  after(async () => {
    log.debug("Shutdown cleanly...");
    await delay(5000);
    log.debug("Close browser...");
    await browser.close();

    log.debug("Stop holochain...");
    await setup_conductor.stop_conductor();

    log.debug("Close HTTP server...");
    await http_ctrls.close();

    log.debug("Stop lair...");
    await setup_conductor.stop_lair();

    log.info("Stopping Envoy...");
    await setup.stop();

    await resetTmp();
  });

  it('should fail to sign up without wormhole', async function () {
    this.timeout(30_000)
    const { Client: RPCWebsocketClient } = require('rpc-websockets')

    const agentId = 'uhCAkgHic-Y_Y1C-o9MvNW9KwnqGTNDxyQLjxnL2hETY6BXgONqlT'
    const hhaHash = 'uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo'

    const client = new RPCWebsocketClient(
      `ws://localhost:${envoy.ws_server.port}/hosting/?anonymous=false&hha_hash=${hhaHash}&agent_id=${agentId}`
    )

    const openedPromise = new Promise(resolve => client.once('open', resolve))
    if (client.socket.readyState === 0) {
      await openedPromise
    }

    await client.call('holo/wormhole/event', [agentId])

    const response = await client.call('holo/agent/signup', [hhaHash, agentId])
    expect(response).deep.equal({
      name: 'HoloError',
      message:
        'HoloError: Error: CONDUCTOR CALL ERROR: {"type":"internal_error","data":"Conductor returned an error while using a ConductorApi: GenesisFailed { errors: [ConductorApiError(WorkflowError(SourceChainError(KeystoreError(LairError(Other(OtherError(\\"unexpected: ErrorResponse { msg_id: 11, message: \\\\\\"Failed to fulfill hosted signing request: \\\\\\\\\\\\\'Failed to get signature from Chaperone\\\\\\\\\\\\\'\\\\\\" }\\")))))))] }"}'
    })
    const closedPromise = new Promise(resolve => client.once("close", resolve))
    client.close()
    await closedPromise
  })

  it("should sign-in and make a zome function call", async function() {
    this.timeout(300_000);
    try {
      await page.exposeFunction('encodeHhaHash', (type, buf) => {
        const hhaBuffer = Buffer.from(buf);
        return Codec.HoloHash.encode(type, hhaBuffer);
      });
      const { responseOne, responseTwo } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
        console.log("Registered Happ Hash: %s", registered_happ_hash);

        const client = new Chaperone({
          "mode": Chaperone.DEVELOP,
          "web_user_legend": {},
          "connection": {
            "ssl": false,
            "host": "localhost",
            "port": 4656,
          },

          host_agent_id, // used to assign host (id generated by hpos-seed)
          app_id: registered_happ_hash, // NOT RANDOM: this needs to match the hash of app in hha

          "timeout": 50000,
          "debug": true,
        });
        client.skip_assign_host = true;

        await client.ready(200_000);
        await client.signUp("alice.test.1@holo.host", "Passw0rd!", joiningCode);
        console.log("Finished sign-up for agent: %s", client.agent_id);
        if (client.anonymous === true) {
          throw new Error("Client did not sign-in")
        }
        if (client.agent_id !== "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY") {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }

        let responseOne, responseTwo;
        try {
          responseOne = await client.callZomeFunction(`test`, "test", "pass_obj", {'value': "This is the returned value"});
          responseTwo = await client.callZomeFunction(`test`, "test", "returns_obj", null);
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
          throw err
        }

        // Delay is added so that the zomeCall has time to finish all the signing required
        //and by signing out too soon it would not be able to get all the signature its needs and the test would fail
        await delay(15000);
        await client.signOut();
        console.log("Anonymous AFTER: ", client.anonymous);

        // Test for second agent on same host
        // NEED TO FIX
        await client.signUp("bob.test.1@holo.host", "Passw0rd!", joiningCode);
        console.log("Finished sign-up for agent: %s", client.agent_id);
        if (client.anonymous === true) {
          throw new Error("Client did not sign-in")
        }
        if (client.agent_id !== "uhCAkCxDJXYNJtqI3EszLD4DNDiY-k8au1qYbRNZ84eI7a7x76uc1") {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }
        console.log("BOB Anonymous AFTER: ", client.anonymous);
        await client.signOut();

        return {
          responseOne,
          responseTwo
        }
      }, host_agent_id, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      log.info("Completed evaluation: %s", responseOne);
      log.info("Completed evaluation: %s", responseTwo);
      expect(responseOne).to.have.property("value").which.equals("This is the returned value");
      expect(responseTwo).to.have.property("value").which.equals("This is the returned value");
    } finally {

    }
  });

  it("should sign-up on this Host");
  it("should sign-out");
  it("should process signed-in request and respond");
  it("should have no pending confirmations");
});
