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
const installedAppIds = yaml.load(fs.readFileSync('./script/app-config.yml'));
const { resetTmp, delay } = require("../utils")
const msgpack = require('@msgpack/msgpack');

// NOTE: the test app servicelogger installed_app_id is hard-coded, but intended to mirror our standardized installed_app_id naming pattern for each servicelogger instance (ie:`${hostedAppHha}::servicelogger`)
const HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID = installedAppIds[0].app_name;

let browser;

async function create_page(url) {
  const page = await browser.newPage();

  log.info("Go to: %s", url);
  await page.goto(url, {
    "waitUntil": "networkidle0"
  });

  return page;
}

class PageTestUtils {
  constructor(page) {
    this.logPageErrors = () => page.on('pageerror', async error => {
      if (error instanceof Error) {
        log.silly(error.message);
      } else
        log.silly(error);
    });

    this.describeJsHandleLogs = () => page.on('console', async msg => {
      const args = await Promise.all(msg.args().map(arg => this.describeJsHandle(arg)))
        .catch(error => console.log(error.message));
      console.log(args);
    });

    this.describeJsHandle = (jsHandle) => {
      return jsHandle.executionContext().evaluate(arg => {
        if (arg instanceof Error)
          return arg.message;
        else
          return arg;
      }, jsHandle);
    };
  }
}

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const host_agent_id = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k'

log.info("Host Agent ID: %s", host_agent_id);

const envoy_mode_map = {
  production: 0,
  develop: 1,
}

// Note: All envoyOpts.dnas will be registered via admin interface with the paths provided here
const envoyOpts = {
  mode: envoy_mode_map.develop,
  app_port_number: 0,
}

const getHostAgentKey = async (appClient) => {
  const appInfo = await appClient.appInfo({
    installed_app_id: HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID
  });
  const agentPubKey = appInfo.cell_data[0].cell_id[1];
  return {
    decoded: agentPubKey,
    encoded: Codec.AgentId.encode(agentPubKey)
  }
}
const REGISTERED_HAPP_HASH = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"

describe("Server", () => {
  let envoy;
  let server;
  let http_ctrls, http_url;
  let registered_agent;

  before(async function() {
    this.timeout(150_000);

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
  });

  after(async () => {
    log.debug("Shutdown cleanly...");
    await delay(10000);
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

  it("should sign-in and make a zome function call", async function() {
    this.timeout(300_000);

    try {
      const page_url = `${http_url}/html/chaperone.html`
      const page = await create_page(page_url);
      const pageTestUtils = new PageTestUtils(page)

      pageTestUtils.logPageErrors();
      pageTestUtils.describeJsHandleLogs();

      await page.exposeFunction('fetchServiceloggerCellId', async () => {
        let serviceloggerCellId;
        try {
          // REMINDER: there is one servicelogger instance per installed hosted app, each with their own installed_app_id
          const serviceloggerAppInfo = await envoy.hcc_clients.app.appInfo({
            installed_app_id: HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID
          });
          serviceloggerCellId = serviceloggerAppInfo.cell_data[0].cell_id;
        } catch (error) {
          throw new Error(JSON.stringify(error));
        }
        return serviceloggerCellId;
      });

      // Note: the host must set servicelogger settings prior to any activity logs being issued (otherwise, the activity log call will fail).
      await page.exposeFunction('setupServiceLoggerSettings', async (servicelogger_cell_id) => {
        const settings = {
          // Note: for the purposes of simplifying the test, the host is also the provider
          provider_pubkey: Codec.AgentId.encode(servicelogger_cell_id[1]),
          max_fuel_before_invoice: 3,
          price_compute: 1,
          price_storage: 1,
          price_bandwidth: 1,
          max_time_before_invoice: [604800, 0]
        }
        let logger_settings;
        try {
          logger_settings = await envoy.hcc_clients.app.callZome({
            // Note: Cell ID content MUST BE passed in as a Byte Buffer, not a u8int Byte Array
            cell_id: [Buffer.from(servicelogger_cell_id[0]), Buffer.from(servicelogger_cell_id[1])],
            zome_name: 'service',
            fn_name: 'set_logger_settings',
            payload: settings,
            cap: null,
            provenance: Buffer.from(servicelogger_cell_id[1])
          });
        } catch (error) {
          throw new Error(JSON.stringify(error));
        }
        return logger_settings;
      });

      await page.exposeFunction('encodeHhaHash', (type, buf) => {
        const hhaBuffer = Buffer.from(buf);
        return Codec.HoloHash.encode(type, hhaBuffer);
      });
      const { responseOne, responseTwo } = await page.evaluate(async function (host_agent_id, registered_agent, registered_happ_hash) {
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
        await client.signUp("alice.test.1@holo.host", "Passw0rd!");
        console.log("Finished sign-up for agent: %s", client.agent_id);
        if (client.anonymous === true) {
          throw new Error("Client did not sign-in")
        }
        if (client.agent_id !== "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY") {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }

        // Set logger settings for hosted app (in real word scenario - will be done when host installs app):
        try {
          const servicelogger_cell_id = await window.fetchServiceloggerCellId();
          console.log("Found servicelogger cell_id: %s", servicelogger_cell_id);

          // NOTE: The host settings must be set prior to creating a service activity log with servicelogger (eg: when making a zome call from web client)...
          const logger_settings = await window.setupServiceLoggerSettings(servicelogger_cell_id);
          console.log("happ service preferences set in servicelogger as: %s", logger_settings);
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
          throw err;
        }
        let responseOne, responseTwo;
        try {
          responseOne = await client.callZomeFunction(`test`, "test", "pass_obj", {'value': "This is the returned value"});
          responseTwo = await client.callZomeFunction(`test`, "test", "returns_obj", null);
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
          throw err
        }

        function delay(t, val) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              resolve(val);
            }, t);
          });
        }
        // Delay is added so that the zomeCall has time to finish all the signing required
        //and by signing out too soon it would not be able to get all the signature its needs and the test would fail
        await delay(10000);
        await client.signOut();
        console.log("Anonymous AFTER: ", client.anonymous);

        // Test for second agent on same host
        await client.signUp("bob.test.1@holo.host", "Passw0rd!");
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
      }, host_agent_id, registered_agent, REGISTERED_HAPP_HASH);

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
