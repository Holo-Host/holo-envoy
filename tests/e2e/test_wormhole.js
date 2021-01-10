const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

// const why				= require('why-is-node-running');
const expect				= require('chai').expect;
const { structs, ...lair }		= require('@holochain/lair-client');


const { init }				= require("../../build/wormhole.js");

const LAIR_SOCKET			= path.resolve( __dirname, '../lair/socket' );
const CONDUCTOR_SOCKET			= path.resolve( __dirname, '../shim_socket' );


describe("Wormhole tests", () => {
    let wormhole;

    before(async () => {
	wormhole			= await init( LAIR_SOCKET, CONDUCTOR_SOCKET );
    });
    after(async () => {
	await wormhole.stop();
    });

    it("should process request and respond", async () => {
	let lair_client;
	try {
	    let recv_unlock		= false;
	    lair_client			= await lair.connect( CONDUCTOR_SOCKET );
	    log.info("Lair client", lair_client );

	    lair_client.on('UnlockPassphrase', request => {
		log.normal("Received UnlockPassphrase request");
		recv_unlock		= true;
		request.reply( "Passw0rd!" );
	    });

	    let resp			= await lair_client.request( new structs.TLS.CreateCert.Request( 512 ) );

	    expect( resp.get(0)		).to.be.a('number');
	    expect( resp.get(1)		).to.be.a('uint8array');
	    expect( resp.get(2)		).to.be.a('uint8array');
	    expect( recv_unlock		).to.be.true;
	} catch (err) {
	    console.error( err );
	} finally {
	    lair_client.destroy();
	}
    });

});
