const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const fs				= require('fs');
const expect				= require('chai').expect;
const fetch				= require('node-fetch');
const puppeteer				= require('puppeteer');

const http_servers			= require('../setup_http_server.js');
const conductor				= require("../setup_conductor.js");
const setup				= require("../setup_envoy.js");

let browser;

async function create_page ( url ) {
    const page				= await browser.newPage();
    
    page.on("console", async ( msg ) => {
    	log.silly("From puppeteer: console.log( %s )", msg.text() );
    });
    
    log.info("Go to: %s", url );
    await page.goto( url, { "waitUntil": "networkidle0" } );

    return page;
}

function delay(t, val) {
    return new Promise(function(resolve) {
	setTimeout(function() {
	    resolve(val);
	}, t);
    });
}

// NOT RANDOM: this instance_prefix matches the hha_hash hard-coded in Chaperone for DEVELOP mode
const instance_prefix				= "QmV1NgkXFwromLvyAmASN7MbgLtgUaEYkozHPGUxcHAbSL";
const host_agent_id				= fs.readFileSync('./AGENTID', 'utf8').trim();
log.info("Host Agent ID: %s", host_agent_id );


describe("Server", () => {

    let envoy;
    let server;
    let client;
    let http_ctrls, http_url;

    before(async function() {
	this.timeout(10_000);

	log.info("Starting conductor");
	await conductor.start();

	envoy				= await setup.start();
	server				= envoy.ws_server;

	log.info("Waiting for Conductor connections...");
	await envoy.connected;

	http_ctrls			= http_servers();
	browser				= await puppeteer.launch();
	log.debug("Setup config: %s", http_ctrls.ports );
	
    	http_url			= `http://localhost:${http_ctrls.ports.chaperone}`;
    });
    after(async () => {
	log.debug("Shutdown cleanly...");
	log.debug("Close browser...");
	await browser.close();

	log.debug("Close HTTP server...");
	await http_ctrls.close();
	
	log.info("Stopping Envoy...");
	await setup.stop();

	log.info("Stopping Conductor...");
	await conductor.stop();
    });
    
    it("should sign-in and make a zome function call", async function () {
	this.timeout( 30_000 );
	try {
	    let response;
	    const page_url		= `${http_url}/html/chaperone.html`
    	    const page			= await create_page( page_url );
	    
	    response			= await page.evaluate(async function ( host_agent_id, instance_prefix )  {
		const client = new Chaperone({
		    "mode": Chaperone.DEVELOP,

		    "connection": {
			"ssl": false,
			"host": "localhost",
			"port": 4656,
		    },
		    
		    host_agent_id,
		    "instance_prefix": instance_prefix, // NOT RANDOM: this matches the hash
							// hard-coded in Chaperone

		    "timeout": 2000,
		    "debug": true,
		});
		client.skip_assign_host	= true;

		function delay(t, val) {
		    return new Promise(function(resolve) {
			setTimeout(function() {
			    resolve(val);
			}, t);
		    });
		}
		
		await client.ready( 2_000 );

		await client.signUp( "someone@example.com", "Passw0rd!" );

		console.log("Finished sign-up", client.agent_id );
		if ( client.anonymous === true )
		    return console.error("Client did not sign-in");
		if ( client.agent_id !== "HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi" )
		    return console.error("Unexpected Agent ID:", client.agent_id );

		try {
		    console.log( "Calling zome function" );
		    return await client.callZomeFunction( "hosted-happ", "elemental-chat", "transactions", "ledger_state" );
		} catch ( err ) {
		    console.log( err.stack );
		    console.log( typeof err.stack, err.stack.toString() );
		}
	    }, host_agent_id, instance_prefix );

	    log.info("Completed evaluation: %s", response );
	    expect( Object.keys(response.Ok)	).to.have.members([ "balance", "credit", "payable", "receivable", "fees", "available" ]);
	} finally {
	}
    });
    
    // it("should sign-up on this Host", async () => {
    // 	try {
    // 	    await client.signUp( "someone@example.com", "Passw0rd!" );

    // 	    expect( client.anonymous	).to.be.false;
    // 	    expect( client.agent_id	).to.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
    // 	} finally {
    // 	}
    // });

    // it("should sign-out", async () => {
    // 	try {
    // 	    await client.signOut();

    // 	    expect( client.anonymous	).to.be.true;
    // 	    expect( client.agent_id	).to.not.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
    // 	} finally {
    // 	}
    // });

    // it("should process signed-in request and respond", async function () {
    // 	this.timeout(5_000);
    // 	try {
    // 	    await client.signIn( "someone@example.com", "Passw0rd!" );
    // 	    const agent_id		= client.agent_id;

    // 	    expect( agent_id		).to.equal("HcSCjUNP6TtxqfdmgeIm3gqhVn7UhvidaAVjyDvNn6km5o3qkJqk9P8nkC9j78i");
	    
    // 	    const response		= await client.callZomeFunction( "holofuel", "transactions", "ledger_state" );
    // 	    log.debug("Response: %s", response );

    // 	    // {"Ok":{"balance":"0","credit":"0","payable":"0","receivable":"0","fees":"0","available":"0"}}
    // 	    expect( response.Ok			).to.be.an("object");
    // 	    expect( Object.keys(response.Ok)	).to.have.members([ "balance", "credit", "payable", "receivable", "fees", "available" ]);
    // 	} finally {
    // 	}
    // });

    // function delay(t, val) {
    // 	return new Promise(function(resolve) {
    // 	    setTimeout(function() {
    // 		resolve(val);
    // 	    }, t);
    // 	});
    // }
    
    // it("should have no pending confirmations", async function () {
    // 	this.timeout(5_000);
    // 	try {
    // 	    // Give confirmation request some time to finish
    // 	    await delay( 2_000 );

    // 	    expect( envoy.pending_confirms	).to.be.empty;
    // 	    expect( client.pending_confirms	).to.be.empty;
    // 	} finally {
    // 	}
    // });
    
});
