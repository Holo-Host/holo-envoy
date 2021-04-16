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
  app_port_number: 0,
}

describe("Resiliency", () => {
  let envoy, server, browser, browserClient, clientWebsocket;
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

    log.info("Waiting for Conductor to spin up");
    setup_conductor.start_conductor()
    await delay(10000);

    log.info("Waiting to connect to Conductor");
    await envoy.connected;

    log.info("Envoy Connected");

    http_ctrls = http_servers();
    browser = await puppeteer.launch({ headless: false });
    log.debug("Setup config: %s", http_ctrls.ports);
    http_url = `http://localhost:${http_ctrls.ports.chaperone}`;

  /////////////////
    const page_url = `${http_url}/html/chaperone.html`
    // create a second tab on browser to avoid puppeeteer shutting down (by closing the otherwise only tab)
    // ** when running the close tab resiliency test 
    await create_page(page_url, browser);
    page = await create_page(page_url, browser);
    const pageTestUtils = new PageTestUtils(page)

    process.on('error', (reason, p) => {
        console.error('!!!!!!!!!!!!!!!!! >>>>>>>>>>>>>>>>>>> Unhandled Rejection at: Promise', p, 'reason:', reason);
    });

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

  //////
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
  }, 300_000);
  
  after('Shut down all servers', async () => {
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

/////////////////////////////////////////
  it.only('should recover from closed browser tab', async function () {
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

    client.on('holo/call', client.close())

    const signup = await client.call('holo/agent/signup', [hhaHash, agentId])
    expect(signup).to.equal(true)
    console.log("Finished sign-up for agent: %s", client.agent_id);
    expect(client.anonymous).not.to.equal(true)
    expect(client.agent.id).to.equal("uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY")

    const call_spec = {
      "cell_id": [{
        type: 'Buffer',
        data: [
          132,  45,  36,  46,  15,  19, 101, 226,  43,
           99,   6, 110, 232, 159, 112,  62,  23, 136,
          191,  52,  96,  18, 200, 141, 237, 119,  76,
           65, 189, 168,  11, 143,  44, 215, 116, 202,
           56,  72, 168
        ]
      }, Buffer.from(agentId)],
      "dna_alias": 'test',
      "zome": 'test',
      "function": 'pass_obj',
      "args": Buffer.from(msgpack.encode({ 'value': 'This is the returned value' })).toString('base64'),
      "hha_hash": hhaHash
    };

    const payload = {
      "timestamp": [Math.floor(new Date().getTime() / 1000), 0],
      "host_id": "localhost", // check whether passing in host like this works...
      call_spec,
    };

    const responsefailure = await client.call('holo/call', [payload])
    expect(responsefailure).deep.equal({
      name: 'HoloError'
    })
    const closedPromise = new Promise(resolve => client.once("close", resolve))
    await closedPromise

    // /// CHECK ENVOY STATE IS STILL IN SHAPE (IE: global state is correct, connection to Conductor isn't down, and app is NOT deactivated)
    // expect still connected to hcc admin and app client
    // expect pending confirms state is same
    // expect pending sigs state is same
    // expect that app is NOT deactivated

    const responseSuccess = await client.call('holo/call', [payload])
    expect(responseSuccess).to.have.property("value").which.equals("This is the returned value");    
  })
/////////////////////////////////////////
  
  it.skip("should recover from closed browser tab", async function() {
    this.timeout(300_000);

    // set zomecall event listener
    browserClient.on('Network.webSocketFrameSent', async ({requestId, timestamp, response}) => {
      console.log(' >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>  📤 Network.webSocketFrameSent', JSON.parse(response.payloadData).method)
      if (JSON.parse(response.payloadData).method === 'holo/call') {
        // console.log('!! CLOSING TAB...')
        // close page (aka current browser tab)
        // try {
        //     // await page.close()
        //     // or
        //     // console.log('CLIENT >>>> ', client)
        //     // const closedPromise = new Promise(resolve => client.once("close", resolve))
        //     // client.close()
        //     // await closedPromise
        // } catch (error) {
        //     console.log('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ERRRRRRROR!!!')
        // }
        console.log('!! CLOSING CHAPERONE CONNECT...')
        console.log('clientWebsocket : ', clientWebsocket);
      }
    })


    await page.exposeFunction('checkEnvoyState',() => {
      console.log(' ---------------------------------> hcc_clients admin pending requests: ', envoy.hcc_clients.admin.pendingRequests)
    //   console.log(' ---------------------------------> hcc_clients admin closed: ', envoy.hcc_clients.admin)
      console.log(' ---------------------------------> hcc_clients app pending requests: ', envoy.hcc_clients.app.pendingRequests)
    //   console.log(' ---------------------------------> hcc_clients app closed: ', envoy.hcc_clients.app)

      console.log(' ---------------------------------> agent_connections : ', envoy.agent_connections)
      console.log(' ---------------------------------> payload_counter : ', envoy.payload_counter)
      console.log(' ---------------------------------> pending_confirms : ', envoy.pending_confirms)
      console.log(' ---------------------------------> pending_signatures : ', envoy.pending_signatures)
      console.log(' ---------------------------------> agent_wormhole_num_timeouts : ', envoy.agent_wormhole_num_timeouts)
      return {
        hcc_clients: envoy.hcc_clients,
        pending_confirms: envoy.pending_confirms
      }
    });
    

    await page.exposeFunction('setclientWebsocket', (ws) => {
        console.log('WEBSOCKET : ', ws)
        clientWebsocket = ws
    })

    const { hasSignedUp, responsefailure, responseSuccess } = await page.evaluate(async function (host_agent_id, registered_happ_hash, joiningCode) {
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
      if (client.agent_id !== "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY") {
        throw new Error(`Unexpected Agent ID: ${client.agent_id}`)
      }
      hasSignedUp = true

      console.log('CHAP WS >>>>>>>>> ', client.websocket)

      let { hcc_clients, pending_confirms } = window.checkEnvoyState()
      window.setclientWebsocket(client.websocket)
          
      // check still connected to hcc admin and app client
      // check pending confirms state is same
      // check pending sigs state is same
      // >> check that app is NOT deactivated
    console.log('0 >>>>>>>>> pending_confirms : ', pending_confirms)
    console.log('0 >>>>>>>>>>> HCC CLIENTS :', hcc_clients)

    let responsefailure
      try {
        responsefailure = await client.callZomeFunction('test', 'test', 'pass_obj', {'value': 'This is the returned value'});
      } catch (err) {
        console.log('>>>>>>>>>>>>> !!!!!!!!!!!!!! >>>>>>>>>>> CALL ERROR: ', typeof err.stack, err.stack.toString());
        // throw err
      }

      console.log('1 >>>>>>>>> pending_confirms : ', pending_confirms)
      console.log('1 >>>>>>>>>>> HCC CLIENTS :', hcc_clients)

      console.log('CLIENT cell_dictionary', (client.cell_dictionary.test[0]).toString('base64'))      

      return { hasSignedUp, responsefailure, hcc_clients, pending_confirms } //responseSuccess
    }, HOST_AGENT_ID, REGISTERED_HAPP_HASH, SUCCESSFUL_JOINING_CODE)
    
    console.log(' after >>>>>>>>>>>>>>>>>>>>>>>>>> hasSignedUp : ', hasSignedUp)
    expect(hasSignedUp).to.equal(true)
    
    
    log.info("Completed error response: %s", responsefailure);
    console.log('RESPONSE :', responsefailure)
    expect(responsefailure).to.have.property("type").which.equals("error");

    // open up new tab
    page = await create_page(page_url)
    
////////////////////////////

    // ...and re-attempt call:
    // const responseSuccess = await page.evaluate(async function (chaperoneCallZome) {
    //   let response
    //   try {
    //     response = await chaperoneCallZome(`test`, "test", "pass_obj", {'value': "This is the returned value"});
    //   } catch (err) {
    //     console.log(typeof err.stack, err.stack.toString());
    //     throw err
    //   }
    //   return response
    // }, client);

    // log.info("Completed evaluation: %s", responseSuccess);
    // expect(responseSuccess).to.have.property("value").which.equals("This is the returned value");
  })
})
