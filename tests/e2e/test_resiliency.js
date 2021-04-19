const path = require('path')
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const expect = require('chai').expect;
const puppeteer = require('puppeteer')
const http_servers = require('../setup_http_server.js')
const setup = require("../setup_envoy.js")
const setup_conductor = require("../setup_conductor.js")
const RPCWebSocketServer = require('rpc-websockets').Server;
const { create_page, PageTestUtils, fetchServiceloggerCellId, setupServiceLoggerSettings, envoy_mode_map, resetTmp, delay } = require("../utils")

const msgpack = require('@msgpack/msgpack')

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const HOST_AGENT_ID = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k'
log.info("Host Agent ID: %s", HOST_AGENT_ID)

const REGISTERED_HAPP_HASH = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
const SIGNED_IN_AGENT_HASH = "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY"

const SUCCESSFUL_JOINING_CODE = msgpack.encode('joining code').toString('base64')

// Note: All envoyOpts.dnas will be registered via admin interface with the paths provided here
const envoyOpts = {
  mode: envoy_mode_map.develop,
  app_port_number: 0,
}

class WebSocketServer extends RPCWebSocketServer {
  constructor(...args) {
    super(...args);
    const options = args[0] || {};

    this.port = options.port;
    this.log_prefix = `RPC WebSocket server 0.0.0.0:${this.port} >> `;

    log.info(this.log_prefix + "Starting RPC WebSocket server on port %s", this.port);
  }
}
class BrowserHandler {
  constructor() {
    const launch_browser = async () => {
      this.browser = false;
      this.browser = await puppeteer.launch({ headless: false });
      this.browser.on('disconnected', async () => {
        console.log('>>>>>>>>>>> BROWSER DISCONNECTED <<<<<<<<<<<<< ')
        await delay(5000)
        console.log('reconnecting browser...')
        launch_browser()
      });
    }
    
    (async () => {
      await launch_browser()
    })()
  }
}

const wait_for_browser = browser_handler => new Promise((resolve, reject) => {
  const browser_check = setInterval(() => {
    if (browser_handler.browser !== false) {
      clearInterval(browser_check)
      resolve(true)
    }
  }, 100 )
});


describe("Resiliency", () => {
  let envoy, server, browser_handler, browserClient;
  let http_ctrls, http_url, page;

  before('Spin up lair, envoy, conductor, chaperone, and the browser, then sign-in', async function() {
    this.timeout(100_000);

    log.info("Waiting for Lair to spin up");
    setup_conductor.start_lair()
    await delay(10000);

    log.info("Starting Envoy");
    // Note: envoy will try to connect to the conductor but the conductor is not started so it needs to retry
    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;

    log.info('Waiting for Conductor to spin up');
    setup_conductor.start_conductor()
    await delay(10000);

    log.info('Waiting to connect to Conductor');
    await envoy.connected;

    log.info('Envoy Connected');

    http_ctrls = http_servers();
    browser_handler = new BrowserHandler
    await wait_for_browser(browser_handler)
    log.debug('Setup config: %s', http_ctrls.ports)
    http_url = `http://localhost:${http_ctrls.ports.chaperone}`

  /////////////////
    const page_url = `${http_url}/html/chaperone.html`
    // // create a second tab on browser to avoid puppeeteer shutting down (by closing the otherwise only tab)
    // // ** when running the close tab resiliency test
    // await create_page(page_url, browser_handler.browser);
    page = await create_page(page_url, browser_handler.browser);
  //////
    // Set logger settings for hosted app (in real word scenario - will be done when host installs app):
    try {
      const servicelogger_cell_id = await fetchServiceloggerCellId(envoy.hcc_clients.app);
      console.log('Found servicelogger cell_id: %s', servicelogger_cell_id);
      // NOTE: The host settings must be set prior to creating a service activity log with servicelogger (eg: when making a zome call from web client)
      const logger_settings = await setupServiceLoggerSettings(envoy.hcc_clients.app, servicelogger_cell_id);
      console.log('happ service preferences set in servicelogger as: %s', logger_settings);
    } catch (err) {
      console.log(typeof err.stack, err.stack.toString());
      throw err;
    }    
  }, 500_000);

  beforeEach('reset netwok ws listeners ', async () => {
    const pageTestUtils = new PageTestUtils(page)
    pageTestUtils.logPageErrors();
    pageTestUtils.describeJsHandleLogs();
    page.once('load', () => console.info('✅ Page is loaded'))
    page.once('close', () => console.info('⛔ Page is closed'))

    browserClient = page._client
    browserClient.on('Network.webSocketCreated', ({ requestId, url }) => {
      console.log('✅ 🔓 Network.webSocketCreated', requestId, url)
    })
    browserClient.on('Network.webSocketFrameSent', ({requestId, timestamp, response}) => {
      console.log(' 📤 Network.webSocketFrameSent', requestId, timestamp, response.payloadData)
    })
    browserClient.on('Network.webSocketFrameReceived', ({requestId, timestamp, response}) => {
      console.log(' 📥 Network.webSocketFrameReceived', requestId, timestamp, response.payloadData)
    })
    browserClient.on('Network.webSocketClosed', ({requestId, timestamp}) => {
      console.log('⛔ 🔐 Network.webSocketClosed', requestId, timestamp)
    })
  })
  
  after('Shut down all servers', async () => {
    log.debug('Shutdown cleanly...');
    await delay(5000);
    log.debug('Close browser...');
    await wait_for_browser(browser_handler)
    await browser_handler.browser.close();

    log.debug('Stop holochain...');
    await setup_conductor.stop_conductor();
    
    log.debug('Close HTTP server...');
    await http_ctrls.close();
    
    log.debug('Stop lair...');
    await setup_conductor.stop_lair();
    
    log.info("Stopping Envoy...");
    await setup.stop();
    
    await resetTmp();
  });
  

  it('Should recover from closed browser tab during zome-call once signed back in successfully', async function() {
    this.timeout(300_000);
    try {
      await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
        console.log('Registered Happ Hash: %s', registered_happ_hash);

        const client = new Chaperone({
          'mode': Chaperone.DEVELOP,
          'web_user_legend': {},
          'connection': {
            'ssl': false,
            'host': 'localhost',
            'port': 4656,
          },

          host_agent_id, // used to assign host (id generated by hpos-seed)
          app_id: registered_happ_hash, // NOT RANDOM: this needs to match the hash of app in hha

          'timeout': 50000,
          'debug': true,
        });
        client.skip_assign_host = true;

        await client.ready(200_000);
        await client.signUp('alice.test.1@holo.host', 'Passw0rd!', joiningCode);
        console.log('Finished sign-up for agent: %s', client.agent_id);
        if (client.anonymous === true) {
          throw new Error('Client did not sign-in')
        }
        if (client.agent_id !== 'uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY') {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }

        let responseOne, responseTwo;
        try {
          client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
          client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
          client.callZomeFunction('test', 'test', 'returns_obj', null);
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
        }
      }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      await page.close()
      const page_url = `${http_url}/html/chaperone.html`
      page = await create_page(page_url, browser);

      await delay(1000)

      let response = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
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
        await client.signIn('alice.test.1@holo.host', 'Passw0rd!');
        console.log('Finished sign-up for agent: %s', client.agent_id);
        if (client.anonymous === true) {
          throw new Error('Client did not sign-in')
        }
        if (client.agent_id !== 'uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY') {
          throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
        }

        let response;
        try {
          response = client.callZomeFunction(`test`, 'test', 'pass_obj', {'value': 'This is the returned value'});
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
          throw err
        }
        return response
      }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      log.info('Completed evaluation: %s', response)
      expect(response).to.have.property('value').which.equals('This is the returned value')
    } finally {
    }
  })

  it.only('should recover from host shutting off in middle of zome call', async function() {
    this.timeout(300_000);
    let pageError;

    // page.on('pageerror', async error => {
    //   if (error instanceof Error) {
    //     log.silly(error.message);
    //     pageError = error
    //   }
    // })

    // set zomecall event listener
    browserClient.on('Network.webSocketFrameSent', async ({requestId, timestamp, response}) => {
      console.log(' >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>  📤 Network.webSocketFrameSent', JSON.parse(response.payloadData).method)
      if (JSON.parse(response.payloadData).method === 'holo/call') {
        console.log('!! CLOSING envoy server...')
        server.close()
      }
    })

    await page.exposeFunction('checkEnvoyState', (expectedAppState) => {
      console.log(' ---------------------------------> hcc_clients admin: ', envoy.hcc_clients.admin)
      console.log(' ---------------------------------> hcc_clients app: ', envoy.hcc_clients.app)
      console.log(' ---------------------------------> agent_connections : ', envoy.agent_connections)
      console.log(' ---------------------------------> agent_wormhole_num_timeouts : ', envoy.agent_wormhole_num_timeouts)
      console.log('------------------------------------------>  app_states (for current cell) : ', envoy.app_states[`${REGISTERED_HAPP_HASH}:${SIGNED_IN_AGENT_HASH}`])
      return {
        isConductorConnected: !!envoy.hcc_clients.admin & !!envoy.hcc_clients.app,
        isChaperoneConnection: !!envoy.agent_connections,
        doWormholeTimeoutsExist: !!envoy.agent_wormhole_num_timeouts,
        isAppStateCorect: envoy.app_states[`${REGISTERED_HAPP_HASH}:${SIGNED_IN_AGENT_HASH}`] === expectedAppState
      }
    })

    await page.exposeFunction('alertWormholeTimeoutNo', () => {
      let wormholeTimeouts
      console.log(' >>>>>>>>>> checking.... ')
      const intervalId = setInterval(() => {
        console.log(' ---------------------------------> agent_wormhole_num_timeouts : ', envoy.agent_wormhole_num_timeouts)
        wormholeTimeouts = envoy.agent_wormhole_num_timeouts[SIGNED_IN_AGENT_HASH]
        if (wormholeTimeouts >= 1) {
          console.log(' >>>>>>>>>> clearing interval ')
          clearInterval(intervalId)
  
          console.log(' >>>>>>>>>> opening server...  ')
          server = new WebSocketServer({
            "port": 4656,
            "host": "0.0.0.0"
          });
          console.log(' >>>>>>>>>> new server : ', server)
        }
      }, 1000);
      return wormholeTimeouts
    })

    await page.exposeFunction('expectEquals', (value, expecation) => {
      expect(value).to.equal(expecation)
    })

    await page.exposeFunction('delay', delay)

    const { hasSignedUp, responsefailure } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode, pageError, SIGNED_IN_AGENT_HASH) {
      let hasSignedUp = false
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
        throw new Error("Client did not sign-up")
      }
      if (client.agent_id !== SIGNED_IN_AGENT_HASH) {
        throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
      }
      hasSignedUp = true

    //  let { isConductorConnected, isChaperoneConnection, doWormholeTimeoutsExist, isAppStateCorect  } = window.checkEnvoyState('active')
    //  console.log('0 >>>>>>>>> isConductorConnected : ', isConductorConnected)
    //  console.log('0 >>>>>>>>>>> isChaperoneConnection:', isChaperoneConnection)
    //  console.log('0 >>>>>>>>> doWormholeTimeoutsExist : ', doWormholeTimeoutsExist)
    //  console.log('0 >>>>>>>>>>> isAppStateCorect:', isAppStateCorect)
    //  expectEquals(isConductorConnected, true)
    //  expectEquals(isChaperoneConnection, true)
    //  expectEquals(doWormholeTimeoutsExist, false)
    //  expectEquals(isAppStateCorect, true)

      window.alertWormholeTimeoutNo()

      let responsefailure
      try {
        responsefailure = client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
        // responsefailure = Promise.race([
        // client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'}),
        //   new Promise((resolve, reject) => {
        //     let waitId = setTimeout(() => {
        //       clearTimout(waitId);
        //       reject('Call timed out...');
        //     }, 300000)
        //     while (!pageError){
        //       console.log("pageError : ", pageError)
        //       console.log('waiting....')
        //     }
        //     resolve(pageError)
        //   })
        // ])
      } catch (err) {
        console.log(typeof err.stack, err.stack.toString())
        throw err
      }

      // // check still connected to hcc admin and app client
      // // check pending confirms state is same
      // // check pending sigs state is same
      // // >> check that app is NOT deactivated (ie: app_state !== 'deactivated')
      // ({ isConductorConnected, isChaperoneConnection, doWormholeTimeoutsExist, isAppStateCorect  } = window.checkEnvoyState('deactivated'))
      // console.log('1 >>>>>>>>> isConductorConnected : ', isConductorConnected)
      // console.log('1 >>>>>>>>>>> isChaperoneConnection:', isChaperoneConnection)
      // console.log('1 >>>>>>>>> doWormholeTimeoutsExist : ', doWormholeTimeoutsExist)
      // console.log('1 >>>>>>>>>>> isAppStateCorect:', isAppStateCorect)
      // expectEquals(isConductorConnected, true)
      // expectEquals(isChaperoneConnection, true)
      // expectEquals(doWormholeTimeoutsExist, false)
      // expectEquals(isAppStateCorect, true)

      return { hasSignedUp, responsefailure }
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE, pageError, SIGNED_IN_AGENT_HASH)
    
    console.log(' after >>>>>>>>>>>>>>>>>>>>>>>>>> hasSignedUp : ', hasSignedUp)
    expect(hasSignedUp).to.equal(true)
    
    log.info("Completed error response: %s", responsefailure);
    console.log('RESPONSE :', responsefailure)
    expect(responsefailure).deep.equal({
      name: 'HoloError',
      message:
        `HoloError: Error: CONDUCTOR CALL ERROR: {"type":"internal_error","data":"Source chain error: KeystoreError: unexpected: ErrorResponse { msg_id: 16, message: \"Failed to fulfill hosted signing request: \\'Failed to get signature from Chaperone\\'\" }"}`
      })
    
    await delay(1000)

  //   // sign in/ restabilsh connection and make new call...
  //   const { hasSignedIn, responseSuccess } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode, SIGNED_IN_AGENT_HASH) {
  //     let hasSignedIn = false
  //     console.log("Registered Happ Hash: %s", registered_happ_hash);
  //     const client = new Chaperone({
  //       "mode": Chaperone.DEVELOP,
  //       "web_user_legend": {},
  //       "connection": {
  //         "ssl": false,
  //         "host": "localhost",
  //         "port": 4656,
  //       },
  //       host_agent_id, // used to assign host (id generated by hpos-seed)
  //       app_id: registered_happ_hash, // NOT RANDOM: this needs to match the hash of app in hha
  //       "timeout": 50000,
  //       "debug": true,
  //     });
  //     client.skip_assign_host = true;

  //     await client.ready(200_000);
  //     await client.signIn("alice.test.1@holo.host", "Passw0rd!");
  //     console.log("Finished sign-in for agent: %s", client.agent_id);
  //     if (client.anonymous === true) {
  //       throw new Error("Client did not sign-up")
  //     }
  //     if (client.agent_id !== SIGNED_IN_AGENT_HASH) {
  //       throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
  //     }
  //     hasSignedIn = true
      
  //     let { hcc_clients, pending_confirms } = window.checkEnvoyState()

  //     // check still connected to hcc admin and app client
  //     // check pending confirms state is same
  //     // check pending sigs state is same
  //     // >> check that app is NOT deactivated
  //     console.log('1 >>>>>>>>> pending_confirms : ', pending_confirms)
  //     console.log('1 >>>>>>>>>>> HCC CLIENTS :', hcc_clients)

  //     let responseSuccess
  //     try {
  //       responseSuccess = await client.callZomeFunction(`test`, "test", "pass_obj", {'value': "This is the returned value"});
  //     } catch (err) {
  //       console.log(typeof err.stack, err.stack.toString());
  //       throw err
  //     }

  //     return { hasSignedIn, responseSuccess, hcc_clients, pending_confirms }
  //   }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE, SIGNED_IN_AGENT_HASH)
  //   expect(hasSignedIn).to.equal(true)
  //   expect(responseSuccess).to.have.property("value").which.equals("This is the returned value");
  })
})