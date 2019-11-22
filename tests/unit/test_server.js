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
    let client;

    before(async () => {
	conductor			= new Conductor();
	envoy				= await setup.start();
	server				= envoy.ws_server;
	// wormhole			= envoy.wormhole;

	log.info("Waiting for Conductor connections...");
	await envoy.connected;

	client				= await setup.client();
    });
    after(async () => {
	log.info("Closing client...");
	await client.close();
	
	log.info("Stopping Envoy...");
	await setup.stop();

	log.info("Stopping Conductor...");
	await conductor.stop();
    });
    
    it("should process request and respond", async () => {
	try {
	    conductor.general.once("call", async function ( data ) {
		const keys		= Object.keys( data );

		expect( keys.length		).to.equal( 4 );
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
	}
    });

    it("should fail wormhole request because Agent is anonymous", async () => {
    });

    it("should process signed-in request and respond", async () => {
	try {
	    await client.signIn( "someone@example.com", "Passw0rd!" );
	    const agent_id		= client.agentId();
	    
	    conductor.general.once("call", async function ( data ) {
		const keys		= Object.keys( data );

		expect( keys.length		).to.equal( 4 );
		expect( data["instance_id"]	).to.equal(`made_up_happ_hash_for_test::${agent_id}-holofuel`);
		expect( data["zome"]		).to.equal("transactions");
		expect( data["function"]	).to.equal("list_pending");
		expect( data["args"]		).to.be.an("object");

		return [];
	    });

	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    log.debug("Response: %s", response );

	    expect( response		).to.deep.equal( [] );
	} finally {
	}
    });
    
    it("should complete wormhole request", async () => {
	try {
	    const agent_id		= client.agentId();
	    
	    conductor.general.once("call", async function ( data ) {
		const signature		= await conductor.wormholeRequest( agent_id, {
		    "some": "entry",
		    "foo": "bar",
		});

		expect( signature	).to.equal("rvSBp8PNV42G93nvzXbqw1wybgVUSNpFhXx6WLzt/Rd3ssc+VHZltOcWB00i8WzYH2e9wllL1m7YmBBDymYGCw==");

		return true;
	    });

	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    log.debug("Response: %s", response );

	    expect( response		).to.equal( true );
	} finally {
	}
    });
    
});
