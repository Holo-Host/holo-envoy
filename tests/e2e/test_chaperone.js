const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const expect = require('chai').expect;
const puppeteer = require('puppeteer');
const http_servers = require('../setup_http_server.js');
const setup = require("../setup_envoy.js");
const setup_conductor = require("../setup_conductor.js");
const { create_page, fetchServiceloggerCellId, setupServiceLoggerSettings, PageTestUtils, envoy_mode_map, resetTmp, delay } = require("../utils")
const msgpack = require('@msgpack/msgpack');

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const HOST_AGENT_ID = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k'
log.info("Host Agent ID: %s", HOST_AGENT_ID);

const REGISTERED_HAPP_HASH = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
const SUCCESSFUL_JOINING_CODE = Buffer.from(msgpack.encode('joining code')).toString('base64')
const INVALID_JOINING_CODE = msgpack.encode('Failing joining Code').toString('base64')

// Note: All envoyOpts.dnas will be registered via admin interface with the paths provided here
const envoyOpts = {
  mode: envoy_mode_map.develop,
}

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
    // must explicitly expose this native function to puppeteer, otherwise it is undefined and errors out
    page.exposeFunction('showErrorMessage', error => {
      if (error instanceof Error) {
        log.silly(error.message)
      } else {
        log.silly(error)
      }
    })

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

  // this test is skipped as the signing error currently throws a panic in holochain,
  // ** which will cause the stale ws connection to choke and thereby fail the setup for remaining tests 
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

    const response = await client.call('holo/agent/signup', [hhaHash, agentId, SUCCESSFUL_JOINING_CODE])
    expect(response).deep.equal({
      name: 'HoloError',
      message:
        'HoloError: Error: CONDUCTOR CALL ERROR: {"type":"internal_error","data":"Conductor returned an error while using a ConductorApi: GenesisFailed { errors: [ConductorApiError(WorkflowError(SourceChainError(KeystoreError(LairError(Other(OtherError(\\"unexpected: ErrorResponse { msg_id: 11, message: \\\\\\"Failed to fulfill hosted signing request: \\\\\\\\\\\\\'Failed to get signature from Chaperone\\\\\\\\\\\\\'\\\\\\" }\\")))))))] }"}'
    })
    const closedPromise = new Promise(resolve => client.once("close", resolve))
    client.close()
    await closedPromise
  })

  it("should return 'inactive' appInfo status after app is deactivated", async function() {
    this.timeout(300_000);
    // 1. sign agent in successfully
    const { signupResponse , signoutResponse} = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
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
      let signupResponse
      try {
        // passing in a random/incorrect joining code
        signupResponse = await client.signUp("carol.test.3@holo.host", "Passw0rd!", joiningCode);
      } catch (error) {
        console.log(typeof error.stack, error.stack.toString())
        throw error
      }
      console.log("Finished sign-up for agent: %s", client.agent_id);
      if (client.anonymous === true) {
        throw new Error("Client did not sign-in")
      }
      if (client.agent_id !== "uhCAksf0kcVKuSnekpvYn1a_b9d1i2-tu6BMoiCbB9hndAA0cwEyU") {
        throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
      }
      console.log('Sign-up response : ', signupResponse);

    // Delay is added so that the in process calls have time to finish
      await delay(15000);
      const signoutResponse = await client.signOut();
      console.log('signoutResponse : ', signoutResponse)

      return { signupResponse, signoutResponse }
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

    log.info("Completed signup response: %s", signupResponse);
    expect(signupResponse).to.equal(true);
    expect(signoutResponse).to.equal(true); 

    // Delay is added so that the signout calls have time to finish
    await delay(15000);

    // 2. Then make appInfo call using the agent   pubkey (since the agent has signed out and closed their ws, their cell should have been deactivated and the app should return as 'inactive')
    // cannot make call from within chaperone instance bc the getAppInfo call doesn't accept provided a `installed_app_id`
    const { Client: RPCWebsocketClient } = require('rpc-websockets')
    const agentId = 'uhCAksf0kcVKuSnekpvYn1a_b9d1i2-tu6BMoiCbB9hndAA0cwEyU'
    const hhaHash = 'uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo'
    const rpc_client = new RPCWebsocketClient(
      `ws://localhost:${envoy.ws_server.port}/hosting/?anonymous=false&hha_hash=${hhaHash}&agent_id=${agentId}`
    )
    const openedPromise = new Promise(resolve => rpc_client.once('open', resolve))
    if (rpc_client.socket.readyState === 0) {
      await openedPromise
    }
    const appInfoResponse = await rpc_client.call('holo/app_info', { installed_app_id: `${hhaHash}:${agentId}` })
    log.info("Completed appInfo response: %s", appInfoResponse);
    expect(appInfoResponse.payload.status).equal('inactive')
    const closedPromise = new Promise(resolve => rpc_client.once("close", resolve))
    rpc_client.close()
    await closedPromise
  })

  it("should sign-in, make a zome function call and sign-out for two different agents", async function() {
    this.timeout(300_000);
    try {
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
        console.log("Alice anonymous after sign-up: ", client.anonymous);

        // Test for second agent on same host
        await client.signUp("bob.test.2@holo.host", "Passw0rd!", joiningCode);
        console.log("Finished sign-up for agent: %s", client.agent_id);
        if (client.anonymous === true) {
          throw new Error("Client did not sign-in")
        }
        if (client.agent_id !== "uhCAkS6PRnk-Yhkw0Wi5rW5IYyPqUtPtFQgyzmEQ6zJ6HqlUu0SxP") {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }
        await client.signOut();
        console.log("BOB anonymous after sign-up: ", client.anonymous);

        return {
          responseOne,
          responseTwo
        }
      }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      log.info("Completed evaluation: %s", responseOne);
      log.info("Completed evaluation: %s", responseTwo);
      expect(responseOne).to.have.property("value").which.equals("This is the returned value");
      expect(responseTwo).to.have.property("value").which.equals("This is the returned value");
    } finally {
    }
  });

  it("should sign-up, sign-out, sign-in, and sign back out successfully", async function() {
    this.timeout(300_000);
    try {
      const { signedUp, signedOutOnce, signedIn, signedOutTwice } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
        console.log("Registered Happ Hash: %s", registered_happ_hash);
        let isSignedOut;
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
        const isSignedUp = await client.signUp("alice.test.1@holo.host", "Passw0rd!", joiningCode);
        console.log('isSignedUp : ', isSignedUp)
        console.log("Finished sign-up for agent: %s", client.agent_id);
        const signedUp = (isSignedUp && client.anonymous === false && client.agent_id === "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY")

        // Delay is added so that the in process calls have time to finish all the signing required
        //and by signing out too soon it would not be able to get all the signature its needs and the test would fail
        await delay(15000);
        isSignedOut = await client.signOut();
        console.log('isSignedOut : ', isSignedOut)
        console.log("alice anonymous after sign-up: ", client.anonymous);
        const signedOutOnce = (isSignedOut && client.anonymous === true && client.agent_id !== "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY")

        const isSignedIn = await client.signIn("alice.test.1@holo.host", "Passw0rd!");
        console.log('isSignedIn : ', isSignedIn)
        console.log("Finished sign-in for agent: %s", client.agent_id);
        const signedIn = (isSignedIn && client.anonymous === false && client.agent_id === "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY")

        // Delay is added so that the in process calls have time to finish all the signing required
        //and by signing out too soon it would not be able to get all the signature its needs and the test would fail
        await delay(15000);
        isSignedOut = await client.signOut();
        console.log('isSignedOut : ', isSignedOut)
        console.log("alice anonymous after sign-in: ", client.anonymous);
        const signedOutTwice = (isSignedOut && client.anonymous === true && client.agent_id !== "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY")

        return {
          signedUp,
          signedOutOnce,
          signedIn,
          signedOutTwice
        }
      }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      log.info("Completed evaluation signedUp: %s", signedUp);
      log.info("Completed evaluation signedOutONce: %s", signedOutOnce);
      log.info("Completed evaluation signedIn: %s", signedIn);
      log.info("Completed evaluation signedOutTwice: %s", signedOutTwice);

      expect(signedUp).to.equal(true);
      expect(signedOutOnce).to.equal(true);
      expect(signedIn).to.equal(true);
      expect(signedOutTwice).to.equal(true);
    } finally {
    }
  });

  it("should sign-in with incorrect joining code and fail", async function() {
    this.timeout(300_000);
    const signupError = await page.evaluate(async function (host_agent_id, registered_happ_hash, invalidJoiningCode) {
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
      let signupError
      try {
        // passing in a random/incorrect joining code
        signupError = await client.signUp("carol.test.3@holo.host", "Passw0rd!", invalidJoiningCode);
      } catch (error) {
        console.log('Caught Sign-up Error: ', error)
        return {
          name: error.name,
          message: error.message
        }
      }
      console.log("Finished signed-up agent: %s", client.agent_id);
      return signupError
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, INVALID_JOINING_CODE);

    log.info("Completed evaluation: %s", signupError);
    expect(signupError.name).to.equal('UserError');
    expect(signupError.message).to.equal('Invalid joining code')
  });

  it("should sign-in with null joining code and fail", async function() {
    this.timeout(300_000);
    const signupError = await page.evaluate(async function (host_agent_id, registered_happ_hash) {
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
      let signupError
      try {
        // passing in no joining code
        signupError = await client.signUp("daniel.test.4@holo.host", "Passw0rd!", null);
      } catch (error) {
        console.log('Caught Sign-up Error: ', error)
        return {
          name: error.name,
          message: error.message
        }
      }
      console.log("Finished signed-up agent: %s", client.agent_id);
      return signupError
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH);

    log.info("Completed evaluation: %s", signupError)
    expect(signupError.name).to.equal('UserError')
    expect(signupError.message).to.equal('Missing membrane proof')
  })

  it("should sign-up on this Host")

  it("should have no pending confirmations", async function() {
    // Give confirmation request some time to finish
    this.timeout(5_000)
    try {
      await delay(2_000);
      expect(envoy.pending_confirms).to.be.empty;
    } finally {}
  })
})
