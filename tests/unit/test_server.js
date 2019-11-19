const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const expect				= require('chai').expect;
const fetch				= require('node-fetch');

const setup				= require("../setup_envoy.js");
const Conductor				= require("../mock_conductor.js");

describe("Server", () => {

    let envoy;
    let server;
    // let wormhole;
    let conductor;

    before(async () => {
	conductor			= new Conductor();
	envoy				= await setup.start();
	server				= envoy.ws_server;
	// wormhole			= envoy.wormhole;

	log.info("Waiting for Conductor connections...");
	await envoy.connected;
    });
    after(async () => {
	log.info("Stopping Envoy...");
	await setup.stop();

	log.info("Stopping Conductor...");
	await conductor.stop();
    });
    
    it("should start server, process request, and respond", async () => {
	const client			= await setup.client();

	try {
	    conductor.general.once("call", async function ( data ) {
		expect( data["instance_id"]	).to.equal("made_up_happ_hash_for_test::holofuel");
		expect( data["zome"]		).to.equal("transactions");
		expect( data["function"]	).to.equal("list_pending");
		expect( data["args"]		).to.be.an("object");

		return [];
	    });

	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    log.debug("Response: %s", response );

	    expect( response		).to.deep.equal( [] );
	} finally {
	    await client.close();
	}
    });
    
});
