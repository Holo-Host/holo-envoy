const { execSync } = require("child_process");
const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const { Codec } = require('@holo-host/cryptolib');

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

const encodeHhaHash = (type, buf) => {
  const hhaBuffer = Buffer.from(buf);
  return Codec.HoloHash.encode(type, hhaBuffer);
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
  encodeHhaHash,
  setupServiceLoggerSettings,
  create_page,
  PageTestUtils
};
