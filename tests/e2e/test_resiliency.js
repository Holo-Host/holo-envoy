const path = require('path')
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});
const expect = require('chai').expect;
const puppeteer = require('puppeteer')
const http_servers = require('../setup_http_server.js')
const setup = require("../setup_envoy.js")
const setup_conductor = require("../setup_conductor.js")
const { create_page, PageTestUtils, fetchServiceloggerCellId, setupServiceLoggerSettings, envoy_mode_map, resetTmp, delay } = require("../utils")

const msgpack = require('@msgpack/msgpack')

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const HOST_AGENT_ID = 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k'
log.info("Host Agent ID: %s", HOST_AGENT_ID)

const REGISTERED_HAPP_HASH = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"

const SUCCESSFUL_JOINING_CODE = msgpack.encode('joining code').toString('base64')

// Note: All envoyOpts.dnas will be registered via admin interface with the paths provided here
const envoyOpts = {
  mode: envoy_mode_map.develop,
  app_port_number: 0
}

class BrowserHandler {
  constructor() {
    const launch_browser = async () => {
      this.browser = false;
      this.browser = await puppeteer.launch({ headless: false });
      this.browser.on('disconnected', async () => {
        log.info('>>>>>>>>>>> BROWSER DISCONNECTED <<<<<<<<<<<<< ')
        await delay(5000)
        log.info('reconnecting browser...')
        launch_browser()
      })
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
  let http_ctrls, http_url, page_url, page;

  before('Spin up lair, envoy, conductor, chaperone, and the browser, then sign-in', async function() {
    this.timeout(100_000)

    log.info("Waiting for Lair to spin up")
    setup_conductor.start_lair()
    await delay(10000)

    log.info("Starting Envoy")
    // Note: envoy will try to connect to the conductor but the conductor is not started so it needs to retry
    envoy = await setup.start(envoyOpts)
    server = envoy.ws_server

    log.info("Waiting for Conductor to spin up")
    setup_conductor.start_conductor()
    await delay(10000);

    log.info("Waiting to connect to Conductor")
    await envoy.connected

    log.info("Envoy Connected")

    http_ctrls = http_servers()
    log.info("http servers running")
  }, 500_000)

  beforeEach('reset netwok ws listeners ', async () => {
    browser_handler = new BrowserHandler
    await wait_for_browser(browser_handler)
    log.debug("Setup config: %s", http_ctrls.ports)
    http_url = `http://localhost:${http_ctrls.ports.chaperone}`

    page_url = `${http_url}/html/chaperone.html`
    page = await create_page(page_url, browser_handler.browser)
    const pageTestUtils = new PageTestUtils(page)

    pageTestUtils.logPageErrors();
    pageTestUtils.describeJsHandleLogs();
    page.once('load', () => console.info('✅ Page is loaded'))
    page.once('close', () => console.info('⛔ Page is closed'))

    await page.exposeFunction('delay', delay)

    await page.exposeFunction('checkEnvoyConnections', (agentId, numReconnects) => {
      const isBrowserConnectionValid = envoy.agent_connections[agentId].length === numReconnects + 1
      const isConductorConnectionValid = !!envoy.hcc_clients.admin && !!envoy.hcc_clients.app
      log.silly('isBrowserConnectionValid && isConductorConnectionValid', isBrowserConnectionValid && isConductorConnectionValid)
      return isBrowserConnectionValid && isConductorConnectionValid
    })

    // Set logger settings for hosted app (in real word scenario - will be done when host installs app):
    try {
      const servicelogger_cell_id = await fetchServiceloggerCellId(envoy.hcc_clients.app)
      console.log("Found servicelogger cell_id: %s", servicelogger_cell_id)
      // NOTE: The host settings must be set prior to creating a service activity log with servicelogger (eg: when making a zome call from web client)
      const logger_settings = await setupServiceLoggerSettings(envoy.hcc_clients.app, servicelogger_cell_id)
      console.log("happ service preferences set in servicelogger as: %s", logger_settings)
    } catch (err) {
      console.log(typeof err.stack, err.stack.toString())
      throw err
    }
    
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

  afterEach('', async () => {
    log.debug("Shutdown Browser cleanly...")
    await delay(5_000)
    log.debug("Close browser...")
    await wait_for_browser(browser_handler)
    await browser_handler.browser.close()
  })
  
  after('Shut down all servers', async () => {
    log.debug("Shutdown Servers cleanly...")
    // await delay(5_000)

    log.debug("Stop holochain...")
    await setup_conductor.stop_conductor()
    
    log.debug("Close HTTP server...")
    await http_ctrls.close()
    
    log.debug("Stop lair...")
    await setup_conductor.stop_lair()
    
    log.info("Stopping Envoy...")
    await setup.stop()
    
    await resetTmp()
  })

  const setNetworkEventHandler = (fn) => {
    let callZomeCount = 0
    const addZomeCallCount = () => callZomeCount++
    browserClient.on('Network.webSocketFrameSent', async ({ response }) => {
      await fn(response, callZomeCount, addZomeCallCount)
    })
  }


  it('Should recover from a browser tab closed during zome call by automatically signing back in, finishing prior zome call, and successfully completing a new one', async function () {
    this.timeout(300_000)
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

        try {
          // simulate multiple ui calls to server
          client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
          client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
          client.callZomeFunction('test', 'test', 'returns_obj', null);
        } catch (err) {
          console.log(typeof err.stack, err.stack.toString());
        }
      }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE);

      await page.close()
      page = await create_page(page_url, browser_handler.browser);

      await delay(1000)

      let response = await page.evaluate(async function (host_agent_id, registered_happ_hash, joining_code) {
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
        await client.signIn('alice.test.1@holo.host', 'Passw0rd!', joining_code);
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

  it('Should recover from internet loss (client closing) in the middle of a zome call', async function() {
    this.timeout(500_000)
    try {
      setNetworkEventHandler(async (response, callZomeCount, addZomeCallCount) => {
        console.log('call zome event count : ', callZomeCount)
        // set zomecall event listener to trigger client closure
        if (JSON.parse(response.payloadData).method === 'holo/call' && callZomeCount === 0) {
          addZomeCallCount()
          log.info('!! closing chaperone client !!')
          await setup.close_connections(server.wss.clients)
        } else if (JSON.parse(response.payloadData).method === 'holo/call' && callZomeCount >= 1) {
          addZomeCallCount()
        }
        return
      })

      const { hasSignedUp, areEnvoyConnectionsValid, isChaperoneValid, responseSuccess } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
      let hasSignedUp = false
      let areEnvoyConnectionsValid = false
      const isChaperoneValid = {
        pendingQueueValid: false,
        userStateValid: false,
      }
      console.log("Registered Happ Hash: %s", registered_happ_hash)
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
      client.skip_assign_host = true

      await client.ready(200_000)
      await client.signUp('bobbo.test.2@holo.host', 'Passw0rd!', joiningCode)
      console.log('Finished sign-up for agent: %s', client.agent_id)
      if (client.anonymous === true) {
        throw new Error('Client did not sign-in')
      }
      if (client.agent_id !== 'uhCAkh1YLBXufxHVem7zUXTChtFSVaBbMuWYSQ7VqWkQ6sU9RtpcZ') {
        throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
      }
      hasSignedUp = true

      try {
      // TEMPORARY: remove race condition and only call zome call once chaperone is updated to return a timeout / server down error after a certain duration of failed connection
      Promise.race([
        client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'}),
        new Promise((resolve, reject) => {
          let waitId = setTimeout(() => {
            clearTimeout(waitId);
            resolve(new Error('ERROR: Call timed out in test'))
          }, 20000)
        })
      ])
      } catch (err) {
        console.log(typeof err.stack, err.stack.toString());
        throw err
      }

      // wait for socket to close
      await delay(2000)

      // check envoy agent connections has one deleted socket and one reconnected socket
      if (window.checkEnvoyConnections(client.agent_id, 1)) {
        areEnvoyConnectionsValid = true
      }
      console.log('envoy state correct ? : ', areEnvoyConnectionsValid)
      // check that the client is still signed in
      isChaperoneValid.userStateValid = client.anonymous === false
      
      // wait for chaperone to automatically sign back in on reconnect
      await delay(3000)
      // wait for new ws socket to be ready
      await client.ready(200_000)
      // wait for envoy to process error
      await delay(8000)
      // TODO: verify the returned error (from envoy)

      // test call again once sigend back in
      let responseSuccess = {}
      try {
        responseSuccess = await client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'})
      } catch (err) {
        console.log(typeof err.stack, err.stack.toString());
        throw err
      }

      // expect that pending confirms is still empty
      isChaperoneValid.pendingQueueValid = Object.keys(client.pending_confirms).length === 0

      return { hasSignedUp, areEnvoyConnectionsValid, isChaperoneValid, responseSuccess }
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE)

    expect(hasSignedUp).to.equal(true)
    expect(areEnvoyConnectionsValid).to.equal(true)
    expect(isChaperoneValid.userStateValid).to.equal(true)
    expect(isChaperoneValid.pendingQueueValid).to.equal(true)

    log.info("Completed successful response: %s", responseSuccess);
    expect(responseSuccess).to.have.property("value").which.equals("This is the returned value")
    } finally {
    }
  })
})