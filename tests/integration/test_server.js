const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const expect				= require('chai').expect;
const fetch				= require('node-fetch');

const conductor				= require("../setup_conductor.js");
const setup				= require("../setup_envoy.js");

describe("Server", () => {

    let envoy;
    let server;
    let client;

    before(async function() {
	this.timeout(10_000);

	log.info("Starting conductor");
	await conductor.start();

	envoy				= await setup.start();
	server				= envoy.ws_server;

	log.info("Waiting for Conductor connections...");
	await envoy.connected;

	client				= await setup.client();
    });
    after(async function () {
	this.timeout(60_000);

	log.info("Closing client...");
	client && await client.close();
	
	log.info("Stopping Envoy...");
	await setup.stop();

	log.info("Stopping Conductor...");
	await conductor.stop( 60_000 );
    });
    
    // it("should process request and respond", async () => {
    // 	try {
    // 	    conductor.general.once("call", async function ( data ) {
    // 		const keys		= Object.keys( data );

    // 		expect( keys.length		).to.equal( 4 );
    // 		expect( data["instance_id"]	).to.equal("QmUgZ8e6xE1h9fH89CNqAXFQkkKyRh2Ag6jgTNC8wcoNYS::holofuel");
    // 		expect( data["zome"]		).to.equal("transactions");
    // 		expect( data["function"]	).to.equal("list_pending");
    // 		expect( data["args"]		).to.be.an("object");

    // 		return [];
    // 	    });

    // 	    const response		= await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
    // 	    log.debug("Response: %s", response );

    // 	    expect( response		).to.deep.equal( [] );
    // 	} finally {
    // 	}
    // });

    // it("should fail wormhole request because Agent is anonymous", async () => {
    // 	try {

    // 	    let failed			= false;
    // 	    conductor.general.once("call", async function ( data ) {
    // 		await conductor.wormholeRequest( client.agent_id, {
    // 		    "some": "entry",
    // 		    "foo": "bar",
    // 		});

    // 		return true;
    // 	    });

    // 	    try {
    // 		await client.callZomeFunction( "holofuel", "transactions", "list_pending" );
    // 	    } catch ( err ) {
    // 		failed			= true;
    // 		expect( err.name	).to.include("HoloError");
    // 		expect( err.message	).to.include("not signed-in");
    // 	    }

    // 	    expect( failed		).to.be.true;
    // 	} finally {
    // 	}
    // });

    // it("should fail to sign-in because this host doesn't know this Agent", async () => {
    // 	try {
    // 	    let failed			= false;
    // 	    try {
    // 		await client.signIn( "someone@example.com", "Passw0rd!" );
    // 	    } catch ( err ) {
    // 		failed			= true;

    // 		expect( err.name	).to.include("HoloError");
    // 		expect( err.message	).to.include("unknown to this Host");
    // 	    }

    // 	    expect( failed		).to.be.true;
    // 	} finally {
    // 	}
    // });

    it("should sign-up on this Host", async () => {
	try {
	    await client.signUp( "someone@example.com", "Passw0rd!" );

	    expect( client.anonymous	).to.be.false;
	    expect( client.agent_id	).to.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
	} finally {
	}
    });

    it("should sign-out", async () => {
	try {
	    await client.signOut();

	    expect( client.anonymous	).to.be.true;
	    expect( client.agent_id	).to.not.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
	} finally {
	}
    });

    it("should process signed-in request and respond", async function () {
	this.timeout(5_000);
    	try {
    	    await client.signIn( "someone@example.com", "Passw0rd!" );
    	    const agent_id		= client.agent_id;

    	    expect( agent_id		).to.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
	    
    	    const response		= await client.callZomeFunction( "holofuel", "transactions", "ledger_state" );
    	    log.debug("Response: %s", response );

	    // {"Ok":{"balance":"0","credit":"0","payable":"0","receivable":"0","fees":"0","available":"0"}}
	    expect( response.Ok			).to.be.an("object");
	    expect( Object.keys(response.Ok)	).to.have.members([ "balance", "credit", "payable", "receivable", "fees", "available" ]);
    	} finally {
    	}
    });

    function delay(t, val) {
	return new Promise(function(resolve) {
	    setTimeout(function() {
		resolve(val);
	    }, t);
	});
    }
    
    it("should have no pending confirmations", async function () {
	this.timeout(5_000);
	try {
	    // Give confirmation request some time to finish
	    await delay( 2_000 );

	    expect( envoy.pending_confirms	).to.be.empty;
	    expect( client.pending_confirms	).to.be.empty;
	} finally {
	}
    });
    
});
