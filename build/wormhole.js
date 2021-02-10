const path = require('path');
const log = require('@whi/stdlog')(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const net = require('net');

const {
  structs,
  MessageParser
} = require('@holochain/lair-client');
const { Codec } = require('@holo-host/cryptolib');

async function init(lair_socket, shim_socket, signing_handler) {
  log.normal('init wormhole');
  let connections = [];

  const shim = net.createServer(async function(conductor_stream) {
    log.info("New conductor connections");
    const lair_stream = net.createConnection(lair_socket);
    const parser = new MessageParser();

    connections.push({
      "lair": lair_stream,
      "conductor": conductor_stream,
      "parser": parser,
    });

    lair_stream.pipe(conductor_stream);
    conductor_stream.pipe(parser);

    for await (let header of parser) {
      if (header === null)
        continue;

      if (header.wire_type_id === structs.Ed25519.SignByPublicKey.Request.WIRE_TYPE) {
        log.normal("Intercepted sign by public key");
        const request = header.wire_type_class.from(await header.payload());
        const pubkey = request.get(0);
        const message = request.get(1);
        const signature = await signing_handler(pubkey, message);

        if (signature !== null) {
          console.log("1 Signature returned to wormhole: ", signature );
          console.log("2 Signature returned to wormhole: ",Codec.Signature.decode(signature) );
          let response = new structs.Ed25519.SignByPublicKey.Response(Codec.Signature.decode(signature));
          conductor_stream.write(response.toMessage(header.id));
          continue;
        }
      }

      log.normal("Forwarding message to Lair");
      header.forward(lair_stream);
    }
  });
  shim.listen(shim_socket);

  return {
    stop() {
      log.normal("Stopping wormhole");
      connections.map(conns => {
        conns.lair.destroy();
        conns.conductor.destroy();
        conns.parser.stop();
      });
      return new Promise(f => shim.close(f));
    },
  };
}


module.exports = {
  init,
};
