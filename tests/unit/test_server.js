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
		expect( data["instance_id"]	).to.equal("made_up_hha_hash_for_test::holofuel");
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
	try {

	    let failed			= false;
	    conductor.general.once("call", async function ( data ) {
		await conductor.wormholeRequest( client.agent_id, {
		    "some": "entry",
		    "foo": "bar",
		});

		return true;
	    });

	    try {
		await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    } catch ( err ) {
		failed			= true;
		expect( err.name	).to.include("HoloError");
		expect( err.message	).to.include("not signed-in");
	    }

	    expect( failed		).to.be.true;
	} finally {
	}
    });

    it("should fail to sign-in because this host doesn't know this Agent", async () => {
	try {
	    let failed			= false;
	    try {
		await client.signIn( "someone@example.com", "Passw0rd!" );
	    } catch ( err ) {
		failed			= true;

		expect( err.name	).to.include("HoloError");
		expect( err.message	).to.include("unknown to this Host");
	    }

	    expect( failed		).to.be.true;
	} finally {
	}
    });

    it("should sign-up on this Host", async () => {
	try {
	    await client.signUp( "someone@example.com", "Passw0rd!" );

	    expect( client.anonymous	).to.be.false;
	    expect( client.agent_id	).to.equal("HcSCI5OfRaeb3twftoo6oNAs5rtbpqufrO8ZwyH7xN3rms6pKeBPaOftd6sbzaz");
	} finally {
	}
    });

    it("should sign-out", async () => {
	try {
	    await client.signOut();

	    expect( client.anonymous	).to.be.true;
	    expect( client.agent_id	).to.not.equal("HcSCI5OfRaeb3twftoo6oNAs5rtbpqufrO8ZwyH7xN3rms6pKeBPaOftd6sbzaz");
	} finally {
	}
    });

    it("should process signed-in request and respond", async () => {
	try {
	    await client.signIn( "someone@example.com", "Passw0rd!" );
	    const agent_id		= client.agent_id;

	    expect( agent_id		).to.equal("HcSCI5OfRaeb3twftoo6oNAs5rtbpqufrO8ZwyH7xN3rms6pKeBPaOftd6sbzaz");
	    
	    conductor.general.once("call", async function ( data ) {
		const keys		= Object.keys( data );

		expect( keys.length		).to.equal( 4 );
		expect( data["instance_id"]	).to.equal(`made_up_hha_hash_for_test::${agent_id}-holofuel`);
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
	    conductor.general.once("call", async function ( data ) {
		const signature		= await conductor.wormholeRequest( client.agent_id, {
		    "some": "entry",
		    "foo": "bar",
		});

		expect( signature	).to.equal("6bSbImC5XLaz7njLhkCx+ReP2ASOgK8/ykpg6YlFlZxs9wqdRF2RcsQImKdugS6PTWsAdOeV8d68Vsw5RriOCg==");

		return true;
	    });

	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
	    log.debug("Response: %s", response );

	    expect( response		).to.be.true;
	} finally {
	}
    });

    it("should have no pending confirmations", async () => {
	try {
	    expect( envoy.pending_confirms	).to.be.empty;
	} finally {
	}
    });
    
});
