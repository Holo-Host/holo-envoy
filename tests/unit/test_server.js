const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const expect				= require('chai').expect;
const fetch				= require('node-fetch');

const setup				= require("../setup_envoy.js");

describe("Server", () => {

    let envoy;
    let server;
    // let wormhole;

    before(async () => {
	envoy				= await setup.start();
	server				= envoy.ws_server;
	// wormhole			= envoy.wormhole;
    });
    after(async () => {
	await setup.stop();
    });
    
    it("should start server, process request, and respond", async () => {
	const client			= await setup.client();

	try {
	    // server.once("greeting", async function ( data ) {
	    // 	return "Hello World";
	    // });

	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    log.debug("Response: %s", response );

	    expect( response		).to.equal( "Hello World" );
	} finally {
	    await client.close();
	}
    });
    
});
