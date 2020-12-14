const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const fs				= require('fs');
const expect				= require('chai').expect;
const fetch				= require('node-fetch');
const puppeteer				= require('puppeteer');

const http_servers			= require('../setup_http_server.js');
// const conductor				= require("../setup_conductor.js");
const setup				= require("../setup_envoy.js");
const { createPartiallyEmittedExpression } = require('typescript');

let browser;


const base64FromBuffer = (buffer) => {
	var binary = "";
	var bytes = new Uint8Array(buffer);
	var len = bytes.byteLength;
	for (var i = 0; i < len; i++) {
	  binary += String.fromCharCode(bytes[i]);
	}
	const base64 = Buffer.from(binary, 'binary').toString('base64')
	return base64;
};

async function create_page ( url ) {
    const page				= await browser.newPage();
    
    page.on("console", async ( msg ) => {
    	log.silly("From puppeteer: console.log( %s )", msg.text() );
    });
    
    log.info("Go to: %s", url );
    await page.goto( url, { "waitUntil": "networkidle0" } );

    return page;
}

class PageTestUtils {  
	constructor( page ) {
	this.logPageErrors			= () => page.on('pageerror', async error => {
		if (error instanceof Error) {
		log.silly( error.message );
	    }
	    else
		log.silly( error );
	});

	this.describeJsHandleLogs	= () => page.on('console', async msg => {
	    const args = await Promise.all(msg.args().map(arg => this.describeJsHandle( arg )))
		  .catch(error => console.log( error.message ));
	    console.log( ...args );
	});

	this.describeJsHandle		= ( jsHandle ) => {
	    return jsHandle.executionContext().evaluate(arg => {
		if (arg instanceof Error)
		    return arg.message;
		else
		    return arg;
	    }, jsHandle);
	};
    }
}

function delay(t, val) {
    return new Promise(function(resolve) {
	setTimeout(function() {
	    resolve(val);
	}, t);
    });
}

// NOT RANDOM: this hha_hash MUST match the one hard-coded in Chaperone for DEVELOP mode
const hha_hash				= "hCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv";
const host_agent_id				= 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k' // fs.readFileSync('./AGENTID', 'utf8').trim();
log.info("Host Agent ID: %s", host_agent_id );

const envoy_mode_map = {
	production: 0,
	develop: 1,
}

const envoyOpts = {
	mode: envoy_mode_map.develop,
	hosted_port_number: 0,
	hosted_app_dnas: [{
		nick: 'test-hha', // 'test-elemental-chat',
		path: '/home/lisa/Documents/gitrepos/holo/rsm-updated/holo-envoy/dnas/holo-hosting-app.dna.gz', // '/home/lisa/Documents/gitrepos/holo/rsm-updated/holo-envoy/dnas/elemental-chat.dna.gz',
	}]
}

// async function waitForMasterPort(){
// 	console.log("HERE...")
// 	let timeoutId;
// 	const getHccClients = timeout => new Promise((f,r) => {
// 		let checkId;
// 		if (envoy.hcc_clients && Object.keys(envoy.hcc_clients).length > 0) {
// 			console.log('>>>>> ????? envoy.HCC_CLIENTS....', envoy.hcc_clients);
// 			clearTimeout(checkId);
// 			f(envoy.hcc_clients);
// 		}
// 		checkId = setTimeout(() => getHccClients(), 500);
// 		timeoutId = setTimeout(r(), timeout);
// 	});
// 	const clients = await getHccClients(2000);
// 	clearTimeout(timeoutId);
// 	console.log(" >>> RETURNING ...", clients);
// 	return clients;
// }

const registerHolochainAgent = async(masterClient) => {
	const pubkey = await masterClient.generateAgentPubKey();
	return {
		encoded: pubkey,
		decoded: base64FromBuffer(pubkey)
	}
}

describe("Server", () => {

    let envoy;
    let server;
    let chaperone_client;
	let http_ctrls, http_url;
	let master_client;
	let registered_agent;

    before(async function() {
	this.timeout(10_000);

	log.info("Starting conductor");
	// await conductor.start();

	envoy				= await setup.start(envoyOpts);
	server				= envoy.ws_server;
	
	log.info("Waiting for Conductor connections...");
	await envoy.connected;

	http_ctrls			= http_servers();
	browser				= await puppeteer.launch();
	log.debug("Setup config: %s", http_ctrls.ports );
	http_url			= `http://localhost:${http_ctrls.ports.chaperone}`;
		
	master_client		= envoy.hcc_clients.master;
	registered_agent	= await registerHolochainAgent(master_client)
	});
    after(async () => {
	log.debug("Shutdown cleanly...");
	log.debug("Close browser...");
	await browser.close();

	log.debug("Close HTTP server...");
	await http_ctrls.close();
	
	log.info("Stopping Envoy...");
	await setup.stop();

	// log.info("Stopping Conductor...");
	// await conductor.stop();
    });
    it("should sign-in and make a zome function call", async function () {
	this.timeout( 300_000 );

	console.log('REGISTERED AGENT : ', registered_agent);
	console.log('>>>>>>>>>>>> DECODED AGENT KEY (passing to chaperone config) : ', registered_agent.decoded);

	try {
	    let response;
	    const page_url		= `${http_url}/html/chaperone.html`
		const page			= await create_page( page_url );
		const pageTestUtils			= new PageTestUtils(page)

		pageTestUtils.logPageErrors();
		pageTestUtils.describeJsHandleLogs();
	    
	    response			= await page.evaluate(async function ( host_agent_id, hha_hash, registered_agent )  {
			console.log('registered_agent: ', registered_agent);

		const client = new Chaperone({
		    "mode": Chaperone.DEVELOP,
			// "agent_id": registered_agent.decoded,
			"web_user_legend": {
				"alice.test.1@holo.host": registered_agent.decoded,
			},
		    "connection": {
				"ssl": false,
				"host": "localhost",
				"port": 4656,
		    },
		    
		    host_agent_id,
		    hha_hash, // NOT RANDOM: this matches the hash
							// hard-coded in Chaperone

		    "timeout": 50000,
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
		
		await client.ready( 200_000 );
		console.log("READY..............");
		await client.signUp( "alice.test.1@holo.host", "Passw0rd!" );
		console.log("SIGNEDUP...........");
		console.log("Finished sign-up", client.agent_id );
		if ( client.anonymous === true )
		    return console.error("Client did not sign-in");
		if ( client.agent_id !== registered_agent.decoded )
		    return console.error("Unexpected Agent ID:", client.agent_id );

		try {
		    console.log( "Calling zome function" );
			// return await client.callZomeFunction( "hosted-app", 'test-elemental-chat', "chat", "list_channels", { category: "General" } );
			// NOTE: This is just way to test zome calls until the zome call args / wasm issue is resolved.
			// ** Until then, testing with a fn that does not require any args (fn is in hha app)
			return await client.callZomeFunction( "hosted-app", 'test-hha', "hha", "get_happs", {});
		} catch ( err ) {
		    console.log( err.stack );
		    console.log( typeof err.stack, err.stack.toString() );
		}
	    }, host_agent_id, hha_hash, registered_agent );

		log.info("Completed evaluation: %s", response );
	    // expect( Object.keys(response[0])	).to.have.members([ "channel", "info", "latest_chunk" ]);
		expect( Object.keys(response[0])	).to.have.members([ "happ_id", "happ_bundle", "provider_pubkey" ]);
	} finally {
	}
    });
    
    // it("should sign-up on this Host", async () => {
    // 	try {
    // 	    await client.signUp( "alice.test.1@holo.host", "Passw0rd!" );

    // 	    expect( client.anonymous	).to.be.false;
    // 	    expect( client.agent_id	).to.equal registered_agent.decoded);
    // 	} finally {
    // 	}
    // });

    // it("should sign-out", async () => {
    // 	try {
    // 	    await client.signOut();

    // 	    expect( client.anonymous	).to.be.true;
    // 	    expect( client.agent_id	).to.not.equal registered_agent.decoded);
    // 	} finally {
    // 	}
    // });

    // it("should process signed-in request and respond", async function () {
    // 	this.timeout(5_000);
    // 	try {
    // 	    await client.signIn( "alice.test.1@holo.host", "Passw0rd!" );
    // 	    const agent_id		= client.agent_id;

    // 	    expect( agent_id		).to.equal registered_agent.decoded);
	    
    // 	    const response		= await client.callZomeFunction( "hosted-app", "elemental-chat", "chat", "list_channels", channel_args );
    // 	    log.debug("Response: %s", response );

    // 	    expect( response			).to.be.an("object");
    // 	    expect( Object.keys(response[0])	).to.have.members([ "channel", "info", "latest_chunk"  ]);
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
