const { execSync } = require("child_process");
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const { Codec } = require('@holo-host/cryptolib');
const installedAppIds = yaml.load(fs.readFileSync('./script/app-config.yml'));

// NOTE: the test app servicelogger installed_app_id is hard-coded, but intended to mirror our standardized installed_app_id naming pattern for each servicelogger instance (ie:`${hostedAppHha}::servicelogger`)
const HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID = installedAppIds[0].app_name;

const envoy_mode_map = {
  production: 0,
  develop: 1,
}

function delay(t, val) {
  return new Promise(function(resolve) {
    setTimeout(function() {
      resolve(val);
    }, t);
  });
}

async function resetTmp() {
  console.log("Removing tmp files ...");
  execSync("make clean-tmp-shim", (error, stdout, stderr) => {
      if (error) {
          console.log(`Reset tests tmp files error: ${error.message}`);
          return;
      }
  });
}

const encodeHhaHash = (type, buf) => {
  const hhaBuffer = Buffer.from(buf);
  return Codec.HoloHash.encode(type, hhaBuffer);
}

const fetchServiceloggerCellId = async (app_client) => {
  let serviceloggerCellId;
  try {
    // REMINDER: there is one servicelogger instance per installed hosted app, each with their own installed_app_id
    const serviceloggerAppInfo = await app_client.appInfo({
      installed_app_id: HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID
    });
    serviceloggerCellId = serviceloggerAppInfo.cell_data[0].cell_id;
  } catch (error) {
    throw new Error(JSON.stringify(error));
  }
  return serviceloggerCellId;
}

const setupServiceLoggerSettings = async (app_client, servicelogger_cell_id) => {
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
  logger_settings = await app_client.callZome({
    // Note: Cell ID content MUST BE passed in as a Byte Buffer, not a u8int Byte Array
    cell_id: [Buffer.from(servicelogger_cell_id[0]), Buffer.from(servicelogger_cell_id[1])],
    zome_name: 'service',
    fn_name: 'set_logger_settings',
    payload: settings,
    cap: null,
    provenance: Buffer.from(servicelogger_cell_id[1])
  });
  return logger_settings;
}

const getHostAgentKey = async (app_client) => {
  const appInfo = await app_client.appInfo({
    installed_app_id: HOSTED_APP_SERVICELOGGER_INSTALLED_APP_ID
  });
  const agentPubKey = appInfo.cell_data[0].cell_id[1];
  return {
    decoded: agentPubKey,
    encoded: Codec.AgentId.encode(agentPubKey)
  }
}

async function create_page(url, browser) {
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
      } else {
        log.silly(error);
      }
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

module.exports = {
  envoy_mode_map,
  delay,
  resetTmp,
  encodeHhaHash,
  fetchServiceloggerCellId,
  setupServiceLoggerSettings,
  getHostAgentKey,
  create_page,
  PageTestUtils
};
