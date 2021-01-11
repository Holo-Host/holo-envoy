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

const HHA_INSTALLED_APP_ID = 'holo-hosting-app';
const EL_CHAT_SERVICELOGGER_INSTALLED_APP_ID = 'elemental-chat-dna:servicelogger';

let browser;

async function create_page ( url ) {
    const page				= await browser.newPage();
    
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
// Register test app in hha  (in real word scenario - will be done when provider registers app in hha):
const registerTestAppInHha = async (hostedClient) => {
	const hhaAppInfo = await hostedClient.appInfo({ installed_app_id: HHA_INSTALLED_APP_ID  });
	const hhaCellId = hhaAppInfo.cell_data[0][0];

	const happBundle = {
		hosted_url:"https://testapp.com",
		happ_alias: "test-app",
		ui_path: "/path/to/test_app_ui.zip",
		name: "Test App Hosted On Web",
		dnas: [{
			hash: "hC0k...",
			path: envoyOpts.hosted_app_dnas[0].path,
			nick: envoyOpts.hosted_app_dnas[0].nick,
		}]
	  };

	  let happRegistrationId;
	  try {
		({ happ_id: happRegistrationId } = await hostedClient.callZome({ 
			// NOTE: Cell ID content MUST be passed in as a byte buffer not a u8int byte-array
		   cell_id: [Buffer.from(hhaCellId[0]), Buffer.from(hhaCellId[1])],
		   zome_name: 'hha',
		   fn_name: 'register_happ',
		   payload: happBundle,
		   cap: null,
		   provenance: Buffer.from(hhaCellId[1])
	   }));
	} catch (error) {
		throw new Error(JSON.stringify(error));
	}

	return Codec.HoloHash.encode('header', happRegistrationId);
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
	
	// TODO: sync start conductor in make file
	// await conductor.start();

	envoy				= await setup.start(envoyOpts);
	server				= envoy.ws_server;
	
	log.info("Waiting for Conductor connections...");
	await envoy.connected;

	http_ctrls			= http_servers();
	browser				= await puppeteer.launch();
	log.debug("Setup config: %s", http_ctrls.ports );
	http_url			= `http://localhost:${http_ctrls.ports.chaperone}`;
		
	hosted_client		= envoy.hcc_clients.hosted;
	service_client		= envoy.hcc_clients.service;

	// NOTE: This is a workaround until wormhole signing is in place. Using the Host Servicelogger Agent Key to call public sign functions for activity log signatures.
	registered_agent	= await getHostAgentKey(service_client);
	log.info('Using host agent (%s) in conductor on service port(%s)', registered_agent, service_client.checkConnection.port);
	
	registered_happ_hash 			= await registerTestAppInHha(hosted_client);
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
	// TODO: Capture step to close the conductor socket in make file for now
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

		// NOTE: Once we begin installing instances of servicelogger, we will need to use hostedAppHha to form the installed_app_id instead - ie: `${hostedAppHha}:servicelogger`
		await page.exposeFunction('fetchServiceloggerCellId', async () => { // async (hostedAppHha) =>
			// NOTE: this servicelogger dna instance is needs to pair with the hosted_app used for zome_calls in this test
			// - reminder: there is one servicelogger instance per installed hosted app, each with their own installed_app_id
			let serviceloggerCellId;
			try {
				// TODO: Replace the installed_app_id with `${hostedAppHha}:servicelogger` once we have implemented servicelogger install pattern
				const serviceloggerAppInfo = await service_client.appInfo({ installed_app_id: EL_CHAT_SERVICELOGGER_INSTALLED_APP_ID});
				serviceloggerCellId = serviceloggerAppInfo.cell_data[0][0];
			} catch (error) {
				throw new Error(JSON.stringify(error));
			}
			
			console.log("serviceloggerCellId: ", serviceloggerCellId);
			return serviceloggerCellId;
		});

		// Note: the host must set servicelogger settings prior to any activity logs being issued (otherwise, the activity log call will fail).
		await page.exposeFunction('setupServiceLoggerSettings', async (servicelogger_cell_id) => {
			const settings = {
				// note: for this example/test, the host is also the provider
				provider_pubkey: Buffer.from(servicelogger_cell_id[1]), // NOTE: THIS MUST BE PASSED IN AS A BUFFER!!!
				max_fuel_before_invoice: 3,
				price_per_unit: 1,
				max_time_before_invoice: [604800, 0]
			}

			let logger_settings; 
			try {
				logger_settings = await service_client.callZome({ 
					 // NOTE: Cell ID content MUST BE PASSED IN AS A BYTE BUFFER!!! >> cannot take a u8 byte array
					cell_id: [Buffer.from(servicelogger_cell_id[0]), Buffer.from(servicelogger_cell_id[1])], // nb: cell_id = [dna_hash_buf, agent_pubkey_buf]
					zome_name: 'service',
					fn_name: 'set_logger_settings',
					payload: settings,
					cap: null,
					provenance: Buffer.from(servicelogger_cell_id[1])
				});
			} catch (error) {
				throw new Error(JSON.stringify(error));
			}	
			return logger_settings;
		});

		await page.exposeFunction('encodeHhaHash', (type, buf) => {
			const hhaBuffer = Buffer.from(buf);
			return Codec.HoloHash.encode(type, hhaBuffer);
		});
	    
	    response			= await page.evaluate(async function ( host_agent_id, registered_agent, registered_happ_hash )  {
			log.info("Registered Web Agent ID: %s", registered_agent );
			log.info("Registered Happ Hash (also used as instance_prefix): %s", registered_happ_hash );

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
		    instance_prefix: registered_happ_hash, // NOT RANDOM: this needs to match the hash of app in hha

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

		// Set logger settings for hosted app (in real word scenario - will be done when host installs app):
		try {
			console.log("\nFetching Hosted App DNA..." );
			const servicelogger_cell_id				= await window.fetchServiceloggerCellId(); // client.hha_hash 
			
			console.log("\nCalling Host ServiceLog Settings Setup ");
			
			// NOTE: The host settings must be set prior to creating a service activity log with servicelogger (ie: when making a zome call from web client)
			const logger_settings = await window.setupServiceLoggerSettings(servicelogger_cell_id);
			console.log("Logger Settings set: ",logger_settings);

			console.log('\nCOMPLETED SETTING SERVICE LOGGER SETTINGS (IN TESTS...) \n');
		} catch (err) {
			console.log( typeof err.stack, err.stack.toString() );
			throw err;
		}

		try {
			console.log("\n >>>>>>>>>>> Calling zome function" );
			console.log("\n >>>>>>>>>>> client.hha_hash", client.hha_hash );

			// return await client.callZomeFunction('test-elemental-chat', "chat", "list_channels", { category: "General" } );
			
			// NOTE: This is just way to test zome calls until the zome call args / wasm issue is resolved.
			// ** Until then, testing with a fn that does not require any args (fn is in hha app)
			const zomeCall = await client.callZomeFunction('test-hha', "hha", "get_happs", {} );
			
			console.log("\n >>>>>>>>>>> zomeCall", zomeCall );

			const hhaAppBuf = zomeCall[0].happ_id;
			const encodedBuf = await window.encodeHhaHash('header', hhaAppBuf);
			const zomeCall2 = await client.callZomeFunction('test-hha', "hha", "get_happ", encodedBuf );

			console.log('COMPLETED ZOME CALL (IN TESTS...): ', zomeCall, zomeCall2);
			return zomeCall
		} catch ( err ) {
		    console.log( err.stack );
		    console.log( typeof err.stack, err.stack.toString() );
		}
	    }, host_agent_id, registered_agent, registered_happ_hash );

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
