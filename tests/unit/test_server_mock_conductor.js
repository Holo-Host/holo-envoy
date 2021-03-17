const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const expect = require('chai').expect;
const fetch = require('node-fetch');
const why = require('why-is-node-running');
const portscanner = require('portscanner');

const setup = require("../setup_envoy.js");
const MockConductor = require('@holo-host/mock-conductor');
const { Codec } = require('@holo-host/cryptolib');

const {
  ZomeAPIResult
} = MockConductor;

const ADMIN_PORT = 4444;
const FAKE_PORT = 4443;
const APP_PORT = 42233;

const envoy_mode_map = {
  production: 0,
  develop: 1,
}

const envoyOpts = {
  mode: envoy_mode_map.develop,
  app_port_number: 0,
  hosted_app: {
    dnas: [{
      nick: 'test-hha',
      path: './dnas/elemental-chat.dna.gz'
    }],
    usingURL: false
  }
}

describe("Server with mock Conductor", () => {
  const INTERNAL_INSTALLED_APP_ID = "holo-hosting-app"
  // Note: The value used for the hosted installed_app_ids
  // ** must match the hha_hash pased to the chaperone server (in setup_envoy.js)
  const HOSTED_INSTALLED_APP_ID = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
  const DNA_ALIAS = "dna_alias";
  // alice@test1.holo.host Passw0rd!
  const AGENT_ID = "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY";
  const DNA_HASH = "uhC0kWCsAgoKkkfwyJAglj30xX_GLLV-3BXuFy436a2SqpcEwyBzm";
  const MOCK_CELL_ID = [Codec.HoloHash.decode(DNA_HASH), Codec.AgentId.decode(AGENT_ID)];
  const MOCK_CELL_DATA = [[MOCK_CELL_ID, DNA_ALIAS]];

  let envoy;
  let server;
  let conductor;
  let client;

  async function checkPorts(port_array) {
    return new Promise((resolve, reject) => {
      portscanner.findAPortInUse(port_array, '127.0.0.1', function(error, port) {
        if (port) {
          reject(new Error(`Port ${port} already used by other process`));
        }
        resolve();
      });
    });
  }

  before("Start mock conductor with envoy and client", async () => {
    await checkPorts([ADMIN_PORT, FAKE_PORT, APP_PORT]);

    // FAKE_PORT is used in appConducotr because of the way MockConductor works:
    // 1st arg is Admin port that does not receive signals
    adminConductor = new MockConductor(ADMIN_PORT);
    appConductor = new MockConductor(FAKE_PORT, APP_PORT);

    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;

    log.info("Waiting for Conductor connections...");
    await envoy.connected;
  });
  beforeEach('Set-up installed_app_ids for test', async () => {
    appConductor.any({ cell_data: MOCK_CELL_DATA })
  });
  afterEach("Close client", async () => {
    if (client && client.opened) {
      if (!client.anonymous) {
        let onDeactivateApp
        const appDeactivated = new Promise((resolve, reject) => onDeactivateApp = resolve)
        const installed_app_id = `${client.hha_hash}:${client.agent_id}`
        adminConductor.once(MockConductor.DEACTIVATE_APP_TYPE, { installed_app_id }, onDeactivateApp)
        log.info("Closing client...");
        await client.close();
        await appDeactivated
      } else {
        log.info("Closing client...");
        await client.close();
      }
      const unusedAdminResponses = Object.entries(adminConductor.responseQueues).filter(([fn, queue]) => queue.length !== 0)
      if (unusedAdminResponses.length) {
        log.warn("Mock admin conductor contains unused responses: %j", unusedAdminResponses)
      }
      adminConductor.clearResponses()
      const unusedAppResponses = Object.entries(appConductor.responseQueues).filter(([fn, queue]) => queue.length !== 0)
      if (unusedAppResponses.length) {
        log.warn("Mock app conductor contains unused responses: %j", unusedAppResponses)
      }
      appConductor.clearResponses()
    }
  });
  after("Close mock conductor with envoy", async () => {
    log.info("Stopping Envoy...");
    await setup.stop();

    log.info("Stopping Conductor...");
    await adminConductor.close();
    await appConductor.close();
  });

  it("should encode and decode back agent id", async () => {
    let result = Codec.AgentId.encode(Codec.AgentId.decode(AGENT_ID));
    expect(result).to.equal(AGENT_ID);
  });

  it("should process request and respond", async () => {
    client = await setup.client({
      web_user_legend : {
        "alice.test.1@holo.host": AGENT_ID,
      }
    });

    try {
      const callZomeData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "zome",
        fn_name: "zome_fn",
        args: {
          zomeFnArgs: "String Input"
        }
      };
      const expected_response = "Hello World";
      appConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);

      const servicelogData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "service",
        fn_name: "log_activity",
        args: {
          zomeFnArgs: "Activity Log"
        }
      };
      const activity_log_response = 'Activity Log Success Hash';
      appConductor.once(MockConductor.ZOME_CALL_TYPE, servicelogData, activity_log_response);

      const response = await client.callZomeFunction("dna_alias", "zome", "zome_fn", {
        zomeFnArgs: "String Input"
      });

      log.debug("Response: %s", response);
      expect(response).to.equal("Hello World");
    } finally {}
  });


  it("should sign-up on this Host without membrane_proof", async () => {
    const agentId = AGENT_ID;
    client = await setup.client({});
    client.skip_assign_host = true;

    try {
      const hhaData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "hha",
        fn_name: "get_happ",
        args: {
          zomeFnArgs: "happ bundle info"
        }
      };
      const happ_bundle_1_details_response = {
        happ_id: Buffer.from('HeaderHash'),
        happ_bundle: {
          hosted_url: 'http://testfuel.holohost.net',
          happ_alias: 'testfuel-console',
          ui_path: 'path/to/compressed/ui/file',
          name: 'TestFuel Console',
          dnas: [{
            hash: 'uhCkk...',
            path: '/path/to/compressed/dna/file',
            nick: 'testfuel'
          }],
        },
        provider_pubkey: Buffer.from('AgentPubKey'),
      };
      appConductor.once(MockConductor.ZOME_CALL_TYPE, hhaData, happ_bundle_1_details_response);

      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${agentId}`

      const appInfo = {
        installed_app_id,
        agent_key: Codec.AgentId.decodeToHoloHash(AGENT_ID),
        dnas: envoyOpts.hosted_app.dnas
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, {
        type: 'success'
      })
      adminConductor.once(
        MockConductor.ACTIVATE_APP_TYPE,
        { installed_app_id },
        { type: 'success' }
      )


      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal(AGENT_ID);
    } finally {}
  });

  it("should sign-up on this Host with membrane_proof", async () => {
    client = await setup.client({});
    client.skip_assign_host = true;

    try {
      const hhaData = {
        cell_id: MOCK_CELL_ID,
        zome_name: "hha",
        fn_name: "get_happ",
        args: {
          zomeFnArgs: "happ bundle info"
        }
      };
      const happ_bundle_2_details_response = {
        happ_id: Buffer.from('HeaderHash'),
        happ_bundle: {
          hosted_url: 'http://holofuel.holohost.net',
          happ_alias: 'holofuel-console',
          ui_path: 'path/to/compressed/ui/file',
          name: 'HoloFuel Console',
          dnas: [{
            hash: 'uhCkk...',
            path: '/path/to/compressed/dna/file',
            nick: 'holofuel'
          }],
        },
        provider_pubkey: Buffer.from('AgentPubKey'),
      };
      appConductor.once(MockConductor.ZOME_CALL_TYPE, hhaData, happ_bundle_2_details_response);

      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}`

      const appInfo = {
        installed_app_id,
        agent_key: Codec.AgentId.decodeToHoloHash(AGENT_ID),
        dnas: [
          {
            ...envoyOpts.hosted_app.dnas[0],
            membrane_proof: 'the unique joining code'
          }
        ]
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, {
        type: 'success'
      })
      adminConductor.once(
        MockConductor.ACTIVATE_APP_TYPE,
        { installed_app_id },
        { type: 'success' }
      )

      await client.signUp(
        'alice.test.1@holo.host',
        'Passw0rd!',
        'the unique joining code'
      )


      expect(client.anonymous).to.be.false;
      expect(client.agent_id).to.equal(AGENT_ID);
    } finally {}
  });

  it("should forward signal from conductor to client", async () => {
    let expectedSignalData = "Hello signal!";
    // Instance of DNA that is emitting signal
    // has to match DNA registered in envoy's dna2hha during Login and agent's ID
    let cellId = MOCK_CELL_ID;

    client = await setup.client({});
    client.skip_assign_host = true;

    try {
      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}`

      const appInfo = {
        installed_app_id,
        agent_key: Codec.AgentId.decodeToHoloHash(AGENT_ID),
        dnas: envoyOpts.hosted_app.dnas
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, {
        type: 'success'
      })
      adminConductor.once(
        MockConductor.ACTIVATE_APP_TYPE,
        { installed_app_id },
        { type: 'success' }
      )

      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      // mock conductor emits signal (has to be the right one)
      log.debug(`Broadcasting signal via mock conductor`);
      await appConductor.broadcastAppSignal(cellId, expectedSignalData);

      // wait for signal to propagate all across
      await delay(1000)

      // client receives this
      let receivedSignalData = client.signalStore;

      expect(receivedSignalData).to.equal(expectedSignalData);
    } finally {}
  });

  it("should forward signal from conductor to client with prefixed DNA hash", async () => {
    let expectedSignalData = "Hello signal!";
    // Instance of DNA that is emitting signal
    // has to match DNA registered in envoy's dna2hha during Login and agent's ID
    let cellId = [Codec.HoloHash.holoHashFromBuffer("dna", MOCK_CELL_ID[0]), Codec.HoloHash.holoHashFromBuffer("agent", MOCK_CELL_ID[1])]

    client = await setup.client({});
    client.skip_assign_host = true;

    try {
      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}`

      const appInfo = {
        installed_app_id,
        agent_key: Codec.AgentId.decodeToHoloHash(AGENT_ID),
        dnas: envoyOpts.hosted_app.dnas
      }
      adminConductor.once(MockConductor.INSTALL_APP_TYPE, appInfo, {
        type: 'success'
      })
      adminConductor.once(
        MockConductor.ACTIVATE_APP_TYPE,
        { installed_app_id },
        { type: 'success' }
      )

      await client.signUp("alice.test.1@holo.host", "Passw0rd!");

      // mock conductor emits signal (has to be the right one)
      log.debug(`Broadcasting signal via mock conductor`);
      await appConductor.broadcastAppSignal(cellId, expectedSignalData);

      // wait for signal to propagate all across
      await delay(1000)

      // client receives this
      let receivedSignalData = client.signalStore;

      expect(receivedSignalData).to.equal(expectedSignalData);
    } finally {}
  });

  it("should sign-out", async () => {
    client = await setup.client({
      agent_id: AGENT_ID
    });
    try {
      await client.signOut();

      expect(client.anonymous).to.be.true;
      expect(client.agent_id).to.not.equal(AGENT_ID);
    } finally {}
  });

  it.skip("should complete wormhole request", async () => {
    client = await setup.client({});
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
    client = await setup.client({});
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
  it("should fail to sign-in because this host doesn't know this Agent");
  it("should handle obscure error from Conductor");
  it("should disconnect Envoy's websocket clients on conductor disconnect");

  it.only("should call ActivateApp and retry if a zome call returns CellMissing", async () => {
    let activateAppCalled = false
    adminConductor.next(({ type, data }) => {
      expect(type).to.equal(MockConductor.ACTIVATE_APP_TYPE)
      activateAppCalled = true;
    });
    appConductor.once(MockConductor.ZOME_CALL_TYPE, {cell_id: MOCK_CELL_ID, zome_name: "zome", fn_name: "zome_fn" }, { type: "internal", data: "CellMissing(...)" }, { returnError: true })
    appConductor.once(MockConductor.ZOME_CALL_TYPE, {cell_id: MOCK_CELL_ID, zome_name: "zome", fn_name: "zome_fn" }, "success")
    client = await setup.client({})
    expect(activateAppCalled).to.be.false
    const result = await client.callZomeFunction("dna_alias", "zome", "zome_fn", "zome args")
    expect(result).to.equal("success")
    expect(activateAppCalled).to.be.true
  })

  it("should call deactivate on conductor when client disconnects", async () => {
    const agent_id = "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY";
    let activateAppCalled = false;
    let deactivateAppCalled = false;
    let onDeactivateApp;
    const deactivateAppPromise = new Promise((resolve, reject) => onDeactivateApp = resolve);

    adminConductor.once(MockConductor.ACTIVATE_APP_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${agent_id}` }, () => {
      activateAppCalled = true;
      return { type: "success" }
    });

    adminConductor.once(MockConductor.DEACTIVATE_APP_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${agent_id}` }, () => {
      deactivateAppCalled = true;
      onDeactivateApp();
      return { type: "success" }
    });


    client = await setup.client({});

    expect(activateAppCalled).to.be.false;
    expect(deactivateAppCalled).to.be.false;

    await client.signIn("alice.test.1@holo.host", "Passw0rd!");

    expect(activateAppCalled).to.be.true;
    expect(deactivateAppCalled).to.be.false;

    await client.close();
    await deactivateAppPromise;
    expect(deactivateAppCalled).to.be.true;
  });

  it("should call deactivate on conductor when client signs out", async () => {
    let activateAppCalled = false;
    let deactivateAppCalled = false;
    let onDeactivateApp;
    const deactivateAppPromise = new Promise((resolve, reject) => onDeactivateApp = resolve);

    adminConductor.once(MockConductor.ACTIVATE_APP_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}` }, () => {
      activateAppCalled = true;
      return { type: "success" }
    });

    adminConductor.once(MockConductor.DEACTIVATE_APP_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}` }, () => {
      deactivateAppCalled = true;
      onDeactivateApp();
      return { type: "success" }
    });


    client = await setup.client({});

    expect(activateAppCalled).to.be.false;
    expect(deactivateAppCalled).to.be.false;

    await client.signIn("alice.test.1@holo.host", "Passw0rd!");

    expect(activateAppCalled).to.be.true;
    expect(deactivateAppCalled).to.be.false;

    await client.signOut();
    await deactivateAppPromise;
    expect(deactivateAppCalled).to.be.true;
  });

  it.only('can return a buffer from a zome call', async () => {
    client = await setup.client({})

    const callZomeData = {
      cell_id: MOCK_CELL_ID,
      zome_name: 'zome',
      fn_name: 'zome_fn'
    }
    const expected_response = Buffer.from([1, 3, 3, 7])

    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      callZomeData,
      expected_response,
    )

    const servicelogData = {
      cell_id: MOCK_CELL_ID,
      zome_name: 'service',
      fn_name: 'log_activity'
    }
    const activity_log_response = 'Activity Log Success Hash'
    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      servicelogData,
      activity_log_response
    )

    const response = await client.callZomeFunction(
      'dna_alias',
      'zome',
      'zome_fn',
      'zome args'
    )

    console.log('Response:', response)

    expect(response).to.be.a("UInt8Array")
    expect(Buffer.from(response).compare(expected_response)).to.equal(0)

  })

  it('should return a useful error message when a conductor call fails', async () => {
    client = await setup.client({})

    const callZomeData = {
      cell_id: MOCK_CELL_ID,
      zome_name: 'zome',
      fn_name: 'zome_fn'
    }
    const expected_response = {
      type: 'error',
      data: {
        type: 'fake conductor error type',
        data: 'fake conductor error data'
      }
    }
    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      callZomeData,
      expected_response.data,
      { returnError: true }
    )

    const servicelogData = {
      cell_id: MOCK_CELL_ID,
      zome_name: 'service',
      fn_name: 'log_activity'
    }
    const activity_log_response = 'Activity Log Success Hash'
    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      servicelogData,
      activity_log_response
    )

    const response = await client.callZomeFunction(
      'dna_alias',
      'zome',
      'zome_fn',
      {
        zomeFnArgs: 'String Input'
      }
    )

    log.debug('Response: %s', response)

    delete response._metadata
    expect(response).to.deep.equal({
      type: 'error',
      payload: {
        source: 'HoloError',
        error: 'HoloError',
        message:
          'Error: CONDUCTOR CALL ERROR: {"type":"fake conductor error type","data":"fake conductor error data"}',
        stack: []
      }
    })
  })

  function delay(t) {
    return new Promise(function(resolve) {
      setTimeout(function() {
        resolve();
      }, t);
    });
  }

  it("should reconnect and successfully handle app_info", async () => {
    const agentId = AGENT_ID;
    client = await setup.client({
      agent_id: agentId
    });
    const callAppInfo = () => client.processCOMBRequest("appInfo");

    const res1 = await callAppInfo();
    expect(res1).to.have.property("cell_data");

    await appConductor.close();
    await adminConductor.close();

    const res2 = await callAppInfo();
    expect(res2).to.deep.equal({
      type: "error",
      payload: {
        "error": "Error",
        "message": "Error while calling envoy app_info: {\"type\":\"error\",\"payload\":{\"source\":\"HoloError\",\"error\":\"HoloError\",\"message\":\"Failed during Conductor AppInfo call\",\"stack\":[]}}"
      }
    });

    adminConductor = new MockConductor(ADMIN_PORT);
    appConductor = new MockConductor(APP_PORT);
    appConductor.any({ cell_data: MOCK_CELL_DATA });

    // Wait for envoy to reconnect
    await Promise.all([
      new Promise(resolve => adminConductor.adminWss.once("connection", resolve)),
      new Promise(resolve => appConductor.adminWss.once("connection", resolve))
    ]);

    const res3 = await callAppInfo();
    expect(res3).to.deep.equal(res1);
  });
});

describe("server without mock conductor to start", () => {
  let envoy;
  let server;

  it("should try to reconnect to conductor if fails on first try", async () => {
    envoy = await setup.start(envoyOpts);
    server = envoy.ws_server;

    let connected = false;
    envoy.connected.then(() => connected = true);
    expect(connected).to.be.false;

    adminConductor = new MockConductor(ADMIN_PORT);
    appConductor = new MockConductor(APP_PORT);
    await envoy.connected;
    expect(envoy.hcc_clients.admin.client.socket.readyState).to.equal(1);
    expect(envoy.hcc_clients.app.client.socket.readyState).to.equal(1);
    log.info("Stopping Envoy...");
    await setup.stop();

    log.info("Stopping Conductor...");
    await adminConductor.close();
    await appConductor.close();
  });
});
