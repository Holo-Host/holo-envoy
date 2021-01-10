const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const net				= require('net');

const { structs, MessageParser }	= require('@holochain/lair-client');



async function init ( lair_socket, shim_socket ) {
    let connections			= [];

    const shim				= net.createServer(async function(conductor_stream) {
	log.info("New conductor connections");
	const lair_stream		= net.createConnection( lair_socket );

	connections.push({
	    "lair": lair_stream,
	    "conductor": conductor_stream,
	});

	lair_stream.pipe( conductor_stream );
	conductor_stream.pipe( lair_stream );

	// const parser			= new MessageParser();
	// conductor_stream.pipe( parser );
	// parser.stop();
    });
    shim.listen( shim_socket );

    return {
	stop () {
	    log.debug("Stopping wormhole");
	    connections.map( conns => {
		conns.lair.destroy();
		conns.conductor.destroy();
	    });
	    return new Promise( f => shim.close(f) );
	},
    };
}


module.exports = {
    init,
};
