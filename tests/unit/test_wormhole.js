const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

// const why				= require('why-is-node-running');
const expect = require('chai').expect;
const {
  structs,
  ...lair
} = require('@holochain/lair-client');


const {
  init
} = require("../../src/shim.js");

const LAIR_SOCKET = path.resolve(__dirname, '../../script/install-bundles/keystore/socket');
const CONDUCTOR_SOCKET = path.resolve(__dirname, '../../script/install-bundles/shim/socket');

describe("Shim tests", () => {
  let shim;
  let fake_signature = Buffer.from("ea067251189fa64a65a33548dc8c4e2989b50d27ec915391bc1491bd52047621d27b097aa352d5470baa9356260cda206d77da5c13d32ab8465f2265bccd7970", "hex");

  afterEach(async () => {
    await shim.stop();
  });

  it("should complete round-trip request to Lair", async () => {
    shim = await init(LAIR_SOCKET, CONDUCTOR_SOCKET, async function(pubkey, message) {
      return fake_signature;
    });

    let shim_client, resp;
    let recv_unlock = false;

    try {
      shim_client = await lair.connect(CONDUCTOR_SOCKET);
      log.info("Lair client", shim_client);

      shim_client.on('UnlockPassphrase', request => {
        log.normal("Received UnlockPassphrase request");
        recv_unlock = true;
        request.reply("Passw0rd!");
      });
      resp = await shim_client.request(new structs.TLS.CreateCert.Request(512));
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      shim_client.destroy();
    }

    expect(resp.get(0)).to.be.a('number');
    expect(resp.get(1)).to.be.a('uint8array');
    expect(resp.get(2)).to.be.a('uint8array');
    expect(recv_unlock).to.be.true;
  });

  it("should complete round-trip request to Envoy", async () => {
    shim = await init(LAIR_SOCKET, CONDUCTOR_SOCKET, async function(pubkey, message) {
      return fake_signature;
    });

    let shim_client, resp;

    try {
      shim_client = await lair.connect(CONDUCTOR_SOCKET);
      log.info("Lair client", shim_client);

      const pub_key = Buffer.from("3ffae1d875986b6bbac03eb277eee505fc36ca3022968f66fb412c4b477dc51c", "hex");
      const message = Buffer.from("0554898a56b4ff4e83be465cd64d0fc9127904a05aaae7b645cbfcc1913b1cd387752b4824114bc1", "hex");
      resp = await shim_client.request(new structs.Ed25519.SignByPublicKey.Request(pub_key, message));
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      shim_client.destroy();
    }

    expect(resp.byteLength).to.equal(80);
    expect(resp.get(0)).to.deep.equal(fake_signature);
  });

  it("should make signing requests concurrently", async () => {
    const concurrent_requests = 5
    const pending_requests = []

    shim = await init(LAIR_SOCKET, CONDUCTOR_SOCKET, async function(pubkey, message) {
      log.info("Signing request sent. Pending: %s", pending_requests.length)
      if (message === Buffer.from("standalone", "utf8")) {
        return fake_signature
      }
      // Only resolve signing requests if they are all in flight at the same time.
      if (pending_requests.length + 1 >= concurrent_requests) {
        for (const cb of pending_requests) {
          cb()
        }
      } else {
        await new Promise(resolve => pending_requests.push(resolve))
      }

      return fake_signature;
    });

    let shim_client, resps;

    try {
      shim_client = await lair.connect(CONDUCTOR_SOCKET);
      log.info("Lair client", shim_client);

      const pub_key = Buffer.from("3ffae1d875986b6bbac03eb277eee505fc36ca3022968f66fb412c4b477dc51c", "hex");
      const message = Buffer.from("0554898a56b4ff4e83be465cd64d0fc9127904a05aaae7b645cbfcc1913b1cd387752b4824114bc1", "hex");

      const resp_promises = []
      for (let i = 0; i < concurrent_requests; i++) {
        log.info("making request %s", i)
        resp_promises.push(shim_client.request(new structs.Ed25519.SignByPublicKey.Request(pub_key, message)));
      }

      log.info("testing standalone request while others are pending")
      await shim_client.request(new structs.Ed25519.SignByPublicKey.Request(pub_key, Buffer.from("standalone", "utf8")))

      resps = await Promise.all(resp_promises)
    } catch (err) {
      console.error(err);
      throw err;
    } finally {
      shim_client.destroy();
    }

    for (const resp of resps) {
      expect(resp.byteLength).to.equal(80);
      expect(resp.get(0)).to.deep.equal(fake_signature);
    }
  })
});
