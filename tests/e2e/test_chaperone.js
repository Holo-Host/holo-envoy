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
const { Codec }			= require('@holo-host/cryptolib');
const { Console } = require('console');
const { CONNREFUSED } = require('dns');

const EL_CHAT_SERVICELOGGER_INSTALLED_APP_ID = 'servicelogger';
const HHA_INSTALLED_APP_ID = 'holo-hosting-app';

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
		// log.silly("From puppeteer: console.log( %s )", ...args );
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

// NOT RANDOM: this instance_prefix MUST match the one hard-coded in Chaperone for DEVELOP mode
const instance_prefix				= "uhCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv"; /// the hash of app in hha-dht  (aka hha_hash)

// NB: The 'host_agent_id' *is not* in the holohash format as it is a holo host pubkey (as generated from the hpos-seed)
const host_agent_id				= 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k' // previously: fs.readFileSync('./AGENTID', 'utf8').trim();

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

const getHostAgentKey = async (serviceClient) => {
	const appInfo = await serviceClient.appInfo({ installed_app_id: EL_CHAT_SERVICELOGGER_INSTALLED_APP_ID  });
	const agentPubKey = appInfo.cell_data[0][0][1];
	return {
		decoded: agentPubKey,
		encoded: Codec.AgentId.encode(agentPubKey)
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
		
	// TODO: UPDATE client to hosted, once resolved install mutliple apps issue with holochain-run-dna
	// hosted_client		= envoy.hcc_clients.hosted;
	service_client		= envoy.hcc_clients.service;

	// NOTE: This is a workaround until wormhole signing is in place. Using the Host Servicelogger Agent Key to call public sign functions for activity log signatures.
	registered_agent	= await getHostAgentKey(service_client); // hosted_client
	log.info('Using host agent (%s) in conductor on service port(%s)', registered_agent, service_client.checkConnection.port);
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

	try {
	    let response;
	    const page_url		= `${http_url}/html/chaperone.html`
		const page			= await create_page( page_url );
		const pageTestUtils			= new PageTestUtils(page)

		pageTestUtils.logPageErrors();
		pageTestUtils.describeJsHandleLogs();

		// note: hack to retreive servicelogger dna hash
		await page.exposeFunction('fetchServiceloggerCellId', async (hha_hash, agent_id) => {
			// fetch hosted app dna hash
			// TODO: update service_client to hosted_client when update port thrgh which the hosted app is installed
			const hostedAppInfo = await service_client.appInfo({ installed_app_id: `${hha_hash}:${agent_id}`});
			const hostedAppDna = hostedAppInfo.cell_data[0][0][0];
			console.log('hostedAppDna : ', hostedAppDna)
			
			// note: this servicelogger dna hash needs to match the hash of the dna instance paired with the hosted_app used for zome_calls in this test
			// - make sure to use the installed_app_id of this cell
			const serviceloggerAppInfo = await service_client.appInfo({ installed_app_id: EL_CHAT_SERVICELOGGER_INSTALLED_APP_ID}); // `${<hostedAppDna>}:servicelogger`
			console.log("serviceloggerAppInfo ", serviceloggerAppInfo);
			const serviceloggerCellId = serviceloggerAppInfo.cell_data[0][0];
			console.log("serviceloggerCellId...", serviceloggerCellId);
			return serviceloggerCellId;
		});

		// Note: the host must set servicelogger settings prior to any activity logs being issued (otherwise, the activity log call will fail).
		await page.exposeFunction('setupServiceLoggerSettings', async (servicelogger_cell_id, host_pubkey) => {
			console.log('servicelogger_cell_id for hosted app >>> ', servicelogger_cell_id);
			console.log('host pubkey >>> ', host_pubkey);

			console.log('AGENT PUBKEY USED TO SET UP SERVICELOGGER SETTINGS : ', Codec.AgentId.decode(host_pubkey))
			// const settings = {
			// 	// note: for this example, the host is also the provider
			// 	provider_pubkey: Codec.AgentId.decode(host_pubkey),
			// 	max_fuel_before_invoice: 3,
			// 	price_per_unit: 1,
			// 	max_time_before_invoice: [604800, 0]
			// }
		
			const logger_settings = await service_client.callZome({ 
				cell_id: servicelogger_cell_id, // cell_id = [dna_hash_buf, agent_pubkey_buf]
				zome_name: 'service',
				fn_name: 'get_logger_settings',
				payload: null, // { settings }
				cap: null,
				provenance: Codec.AgentId.decode(host_pubkey)
			  });
		
			console.log("Logger Settings set: ",logger_settings);
			
			return logger_settings;
		});
	    
	    response			= await page.evaluate(async function ( host_agent_id, instance_prefix, registered_agent )  {
			console.log('registered_agent: ', registered_agent);

		const client = new Chaperone({
		    "mode": Chaperone.DEVELOP,
			"web_user_legend": {
				"alice.test.1@holo.host": registered_agent.encoded,
			},
		    "connection": {
				"ssl": false,
				"host": "localhost",
				"port": 4656,
		    },
		    
		    host_agent_id, // used to assign host (id generated by hpos-seed)
		    instance_prefix, // NOT RANDOM: this matches the hash
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

		function sleep(ms) {
			return new Promise(resolve => setTimeout(resolve, ms));
		}
		
		await client.ready( 200_000 );
		console.log("READY..............");
		await client.signUp( "alice.test.1@holo.host", "Passw0rd!" );
		console.log("Finished sign-up for", client.agent_id );
		if ( client.anonymous === true )
		    return console.error("Client did not sign-in");
		if ( client.agent_id !== registered_agent.encoded )
		    return console.error("Unexpected Agent ID:", client.agent_id );

		try {
			console.log("\nFetching Hosted App DNA..." );
			servicelogger_cell_id				= await window.fetchServiceloggerCellId(client.hha_hash, client.agent_id); 
			
			console.log("\nCalling Host ServiceLog Settings Setup ");
			
			// NOTE: The host settings must be set prior to creating a service activity log with servicelogger (ie: when making a zome call from web client)
			const logger_settings = await window.setupServiceLoggerSettings(servicelogger_cell_id, client.agent_id);
			throw new Error('CHECK hosted_dna LOG >>>>');

			console.log('logger_settings : ', logger_settings),
			console.log('\nCOMPLETED SETTING SERVICE LOGGER SETTINGS (IN TESTS...) \n');
		} catch (err) {
			console.log( typeof err.stack, err.stack.toString() );
			throw err;
		}

		try {
		    console.log("\nCalling zome function" );
			// return await client.callZomeFunction('test-elemental-chat', "chat", "list_channels", { category: "General" } );
			// NOTE: This is just way to test zome calls until the zome call args / wasm issue is resolved.
			// ** Until then, testing with a fn that does not require any args (fn is in hha app)
			const zomeCall = await client.callZomeFunction('test-hha', "hha", "get_happs", {});
			console.log('COMPLETED ZOME CALL (IN TESTS...): ', zomeCall);
			await sleep(50000);
			console.log('FINSIHED SLEEPING....');
			return zomeCall
		} catch ( err ) {
		    console.log( err.stack );
		    console.log( typeof err.stack, err.stack.toString() );
		}
	    }, host_agent_id, instance_prefix, registered_agent );

		log.info("\n\nCHAPERONE TEST FINISHED >>>>> Completed evaluation: %s", response );
	    // expect( Object.keys(response[0])	).to.have.members([ "channel", "info", "latest_chunk" ]);
		expect( Object.keys(response[0])	).to.have.members([ "happ_id", "happ_bundle", "provider_pubkey" ]);
	} finally {
	}
    });
    
    // it("should sign-up on this Host", async () => {
    // 	try {
    // 	    await client.signUp( "alice.test.1@holo.host", "Passw0rd!" );

    // 	    expect( client.anonymous	).to.be.false;
    // 	    expect( client.agent_id	).to.equal registered_agent.encoded);
    // 	} finally {
    // 	}
    // });

    // it("should sign-out", async () => {
    // 	try {
    // 	    await client.signOut();

    // 	    expect( client.anonymous	).to.be.true;
    // 	    expect( client.agent_id	).to.not.equal registered_agent.encoded);
    // 	} finally {
    // 	}
    // });

    // it("should process signed-in request and respond", async function () {
    // 	this.timeout(5_000);
    // 	try {
    // 	    await client.signIn( "alice.test.1@holo.host", "Passw0rd!" );
    // 	    const agent_id		= client.agent_id;

    // 	    expect( agent_id		).to.equal registered_agent.encoded);
	    
    // 	    const response		= await client.callZomeFunction("elemental-chat", "chat", "list_channels", channel_args );
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
