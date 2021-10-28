const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const expect = require('chai').expect;
const portscanner = require('portscanner');
const msgpack = require('@msgpack/msgpack');

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
  hosted_app: {
    dnas: [{
      nick: 'test-hha',
      path: './dnas/elemental-chat.dna'
    }],
    usingURL: false
  }
}

describe("Server with mock Conductor", () => {
  // Note: The value used for the hosted installed_app_ids
  // ** must match the hha_hash pased to the chaperone server (in setup_envoy.js)
  const HOSTED_INSTALLED_APP_ID = "uhCkkCQHxC8aG3v3qwD_5Velo1IHE1RdxEr9-tuNSK15u73m1LPOo"
  const DNA_ALIAS = "dna_alias";
  const HOLO_SUFFIX = ":###zero###";
  // alice@test1.holo.host Passw0rd!
  const AGENT_ID = "uhCAk6n7bFZ2_28kUYCDKmU8-2K9z3BzUH4exiyocxR6N5HvshouY";
  const DNA_HASH = "uhC0kWCsAgoKkkfwyJAglj30xX_GLLV-3BXuFy436a2SqpcEwyBzm";
  const SL_DNA_HASH = "uhC0kHSLbocQFSn5hKAVFc_L34plLD52E37kq6Gw9O3vklQ3Jv7eL"
  const MOCK_CELL_ID = [Codec.HoloHash.decode(DNA_HASH), Codec.AgentId.decode(AGENT_ID)];
  const MOCK_CELL_DATA = {
    cell_data: [{
      cell_id: MOCK_CELL_ID,
      cell_nick: DNA_ALIAS
    }]
  };
  const HOST_AGENT_ID = "uhCAkznM55n7k0VidzF2gHFjr0AXswo3BoDkBBG-8LvvN5atURyAq";
  const ANONYMOUS_CELL_ID = [Codec.HoloHash.decode(DNA_HASH), Codec.AgentId.decode(HOST_AGENT_ID)];
  const ANONYMOUS_CELL_DATA = {
    cell_data: [
      {
        cell_id: ANONYMOUS_CELL_ID,
        cell_nick: DNA_ALIAS,
      }
    ]
  }
  const SL_CELL_ID = [Codec.HoloHash.decode(SL_DNA_HASH), Codec.AgentId.decode(HOST_AGENT_ID)]
  const SL_CELL_DATA = {
    cell_data: [
      {
        cell_id: SL_CELL_ID,
        cell_nick: 'servicelogger',
      }
    ]
  }

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
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, ANONYMOUS_CELL_DATA);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, ANONYMOUS_CELL_DATA);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, ANONYMOUS_CELL_DATA);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}${HOLO_SUFFIX}` }, MOCK_CELL_DATA);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}::servicelogger`}, SL_CELL_DATA);
    // localstorage mock
    const store = {};
    const mockLocalStorage = {
      getItem: function (key) {
         return store[key]
      },
      setItem: function (key, value) {
        return store[key] = value
      },
      removeItem: function (key) {
        delete store[key]
      },
      clear: function () {
        store = {}
      },
    }
    global.window = { localStorage: mockLocalStorage }
  });
  afterEach("Close client", async function() {
    this.timeout(20_000)
    if (client && client.opened) {
      log.info("Closing client...");
      await client.close();
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
    try {
      log.info("Stopping Envoy...");
      await setup.stop();

    } finally {
      log.info("Stopping Conductor...");
      await adminConductor.close();
      await appConductor.close();
    }

  });

  it("should encode and decode back agent id", async () => {
    let result = Codec.AgentId.encode(Codec.AgentId.decode(AGENT_ID));
    expect(result).to.equal(AGENT_ID);
  });

  it("should process request and respond", async () => {
    client = await setup.client({});

    try {
      const callZomeData = {
        cell_id: ANONYMOUS_CELL_ID,
        zome_name: "zome",
        fn_name: "zome_fn",
        args: {
          zomeFnArgs: "String Input"
        }
      };
      const expected_response = "Hello World";
      appConductor.once(MockConductor.ZOME_CALL_TYPE, callZomeData, expected_response);

      const servicelogData = {
        cell_id: SL_CELL_ID,
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

  it('should call service logger to update disk usage', async () => {
    const expected_dna_hash = 'the_expected_dna_hash'
    const expected_hha_hash = 'the_expected_hha_hash'
    envoy.dna2hha = {
      [expected_dna_hash]: expected_hha_hash
    }

    const expected_cell_id = 'cell_id_for_service_logger'

    const app_info = {
      cell_data: [{ cell_id: expected_cell_id }]
    }

    // mock the app info call to get the service logger id
    appConductor.next(app_info)

    // and then the service logger log_disk_usage call
    let log_disk_usage_payload
    appConductor.next(({ type, data }) => {
      log_disk_usage_payload = msgpack.decode(data.payload)
    })


    envoy.updateStorageUsage()

    await delay(100)

    expect(log_disk_usage_payload).to.have.property('total_disk_usage', 1)
    expect(log_disk_usage_payload).to.have.property('integrated_entries')
    expect(log_disk_usage_payload).to.have.property('source_chains')
  })


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

      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${agentId}${HOLO_SUFFIX}`

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

      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}${HOLO_SUFFIX}`

      const appInfo = {
        installed_app_id,
        agent_key: Codec.AgentId.decodeToHoloHash(AGENT_ID),
        dnas: [
          {
            ...envoyOpts.hosted_app.dnas[0],
            membrane_proof: Buffer.from('dGhlIHVuaXF1ZSBqb2luaW5nIGNvZGU=', 'base64') // 'the unique joining code'
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
        'dGhlIHVuaXF1ZSBqb2luaW5nIGNvZGU='
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
      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}${HOLO_SUFFIX}`

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

  it("should forward signal to anonymous client", async () => {
    const expectedSignalData = "Hello signal!";
    const dna_hash = "uhC0kKinJMKs4hiOKZh6qAFM5HAKbqF7AY9LQjbnt1vNdy/Gq6NIT"
    const hha_hash = "uhCkkQPqCC-z7xCnp7y5Twm1sShm501ili6_eDDpPo08TrGivDZyn"
    const cell_id = [Codec.HoloHash.decode(dna_hash), Codec.HoloHash.decode(AGENT_ID)]

    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: hha_hash }, { cell_data: [{ cell_id }]})

    client = await setup.client({ hha_hash });
    client.skip_assign_host = true;

    // mock conductor emits signal (has to be the right one)
    log.debug(`Broadcasting signal via mock conductor`);
    await appConductor.broadcastAppSignal(cell_id, expectedSignalData);

    // wait for signal to propagate all across
    await delay(2_000)

    // client receives this
    const receivedSignalData = client.signalStore;

    expect(receivedSignalData).to.equal(expectedSignalData);
  })

  it("should forward signal from conductor to client with prefixed DNA hash", async () => {
    let expectedSignalData = "Hello signal!";
    // Instance of DNA that is emitting signal
    // has to match DNA registered in envoy's dna2hha during Login and agent's ID
    let cellId = [Codec.HoloHash.holoHashFromBuffer("dna", MOCK_CELL_ID[0]), Codec.HoloHash.holoHashFromBuffer("agent", MOCK_CELL_ID[1])]

    client = await setup.client({});
    client.skip_assign_host = true;

    try {
      const installed_app_id = `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}${HOLO_SUFFIX}`

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

  // TODO: Why is this failing?
  it.skip('should retry service logger confirm if it fails with head moved', async () => {
    client = await setup.client({})

    const callZomeData = {
      cell_id: ANONYMOUS_CELL_ID,
      zome_name: 'zome',
      fn_name: 'zome_fn'
    }

    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      callZomeData,
      "success",
    )

    const servicelogData = {
      cell_id: SL_CELL_ID,
      zome_name: 'service',
      fn_name: 'log_activity'
    }

    let tries = 0

    // Simulate three head moved failures
    for (let i = 0; i < 3; i++) {
      appConductor.once(
        MockConductor.ZOME_CALL_TYPE,
        servicelogData,
        () => {
          tries += 1
          return "source chain head has moved"
        },
        { returnError: true }
      )
    }
    appConductor.once(
      MockConductor.ZOME_CALL_TYPE,
      servicelogData,
      () => {
        tries += 1
        return "service logger success"
      },
    )

    expect(tries).to.equal(0)

    const response = await client.callZomeFunction(
      'dna_alias',
      'zome',
      'zome_fn',
      {
        zomeFnArgs: 'String Input'
      }
    )

    expect(tries).to.equal(4)

    log.debug('Response: %s', response)

    expect(response).to.equal("success")
  })

  it('can return a buffer from a zome call', async () => {
    client = await setup.client({})

    const callZomeData = {
      cell_id: ANONYMOUS_CELL_ID,
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
      cell_id: SL_CELL_ID,
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
      cell_id: ANONYMOUS_CELL_ID,
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
      cell_id: SL_CELL_ID,
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
          `Error: \
CONDUCTOR CALL ERROR: {
  type: 'error',
  data: {
    type: 'fake conductor error type',
    data: 'fake conductor error data'
  }
}`,
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
      agent_id: agentId,
      app_id : HOSTED_INSTALLED_APP_ID
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
        "message": "Error while calling envoy app_info: {\"type\":\"error\",\"payload\":{\"source\":\"HoloError\",\"error\":\"HoloError\",\"message\":\"Conductor disconnected\",\"stack\":[]}}"
      }
    });

    adminConductor = new MockConductor(ADMIN_PORT);
    appConductor = new MockConductor(APP_PORT);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: HOSTED_INSTALLED_APP_ID }, ANONYMOUS_CELL_DATA);
    appConductor.once(MockConductor.APP_INFO_TYPE, { installed_app_id: `${HOSTED_INSTALLED_APP_ID}:${AGENT_ID}${HOLO_SUFFIX}` }, MOCK_CELL_DATA);
    // Wait for envoy to reconnect
    await Promise.all([
      new Promise(resolve => adminConductor.adminWss.once("connection", resolve)),
      new Promise(resolve => appConductor.adminWss.once("connection", resolve))
    ]);

    const res3 = await callAppInfo();
    expect(res3).to.deep.equal(res1);
  });

  it("should not update ServiceLogger concurrently ", async () => {
    client = await setup.client({
      web_user_legend : {
        "alice.test.1@holo.host": AGENT_ID,
      }
    })

    const serviceLoggerCall1 = {
      cell_id: SL_CELL_ID,
      zome_name: "service",
      fn_name: "log_activity1"
    }

    const serviceloggerCall2 = {
      cell_id: SL_CELL_ID,
      zome_name: "service",
      fn_name: "log_activity2"
    }

    let call1Finished = false
    let was1Called = false
    let was2Called = false
    let was2CalledBefore1Finished = false

    appConductor.once(MockConductor.ZOME_CALL_TYPE, serviceLoggerCall1, async () => {
      was1Called = true
      await delay(100)
      call1Finished = true
    });

    appConductor.once(MockConductor.ZOME_CALL_TYPE, serviceloggerCall2, () => {
      was2Called = true
      if (!call1Finished) {
        was2CalledBefore1Finished = true
      }
    });

    envoy.callSlUpdate(serviceLoggerCall1)

    envoy.callSlUpdate(serviceloggerCall2)

    await delay(200)

    expect(was1Called).to.equal(true);
    expect(was2Called).to.equal(true);
    expect(was2CalledBefore1Finished).to.equal(false);
  })
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
