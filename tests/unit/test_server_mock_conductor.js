const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const expect				= require('chai').expect;
const fetch				= require('node-fetch');
const why				= require('why-is-node-running');

const setup				= require("../setup_envoy.js");
const Conductor				= require("../mock_conductor.js");
const { ZomeAPIResult }			= Conductor;

describe("Server with mock Conductor", () => {

    let envoy;
    let server;
    // let wormhole;
    // let conductor;
    let client;

    before(async () => {
	// conductor			= new Conductor();
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

	// log.info("Stopping Conductor...");
	// await conductor.stop();

	// setTimeout( why, 1000 );
    });
     it("test", async () => {});
  
    // it("should process request and respond", async () => {
	// try {
	//     conductor.general.once("call", async function ( data ) {
	// 	const keys		= Object.keys( data );

	// 	expect( keys.length		).to.equal( 4 );
	// 	expect( data["instance_id"]	).to.equal(); // "hCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv::holofuel"
	// 	expect( data["zome"]		).to.equal("chat");
	// 	expect( data["function"]	).to.equal("list_channels");
	// 	expect( data["args"]		).to.be.an("object");

	// 	return ZomeAPIResult([]);
	//     });

	//     const response		= await client.callZomeFunction("elemental-chat", "chat", "list_channels", { category: "General"} );
	//     log.debug("Response: %s", response );

	//     expect( response		).to.deep.equal( [] );
	// } finally {
	// }
    // });

    // it("should fail wormhole request because Agent is anonymous", async () => {
	// try {

	//     let failed			= false;
	//     conductor.general.once("call", async function ( data ) {
	// 	await conductor.wormholeRequest( client.agent_id, {
	// 	    "some": "entry",
	// 	    "foo": "bar",
	// 	});

	// 	return ZomeAPIResult(true);
	//     });

	//     try {
	// 	await client.callZomeFunction( "elemental-chat", "chat", "list_channels", { category: "General"} );
	//     } catch ( err ) {
	// 	failed			= true;
	// 	expect( err.name	).to.include("HoloError");
	// 	expect( err.message	).to.include("not signed-in");
	//     }

	//     expect( failed		).to.be.true;
	// } finally {
	// }
    // });

    // it("should fail to sign-up because conductor disconnected");
    // it("should fail to sign-up because admin/agent/add returned an error");
    // it("should fail to sign-up because HHA returned an error");
    // it("should fail to sign-up because Happ Store returned an error");
    // it("should fail to sign-up because adminInterface call, `installApp`, returned an error");
    // it("should fail to sign-up because adminInterface call, `activateApp`, returned an error");
    // it("should fail to sign-up because adminInterface call, `attachAppInterface`, returned an error");

    // it("should sign-up on this Host", async () => {
	// try {
	//     await client.signUp( "someone@example.com", "Passw0rd!" );

	//     expect( client.anonymous	).to.be.false;
	//     expect( client.agent_id	).to.equal("HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi");
	// } finally {
	// }
    // });

    // it("should sign-out", async () => {
	// try {
	//     await client.signOut();

	//     expect( client.anonymous	).to.be.true;
	//     expect( client.agent_id	).to.not.equal("HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi");
	// } finally {
	// }
    // });

    // it("should fail to sign-in because this host doesn't know this Agent", async () => {
	// try {
	//     let failed			= false;
	//     try {
	// 	await client.signIn( "someone@example.com", "" );
	//     } catch ( err ) {
	// 	failed			= true;

	// 	expect( err.name	).to.include("HoloError");
	// 	expect( err.message	).to.include("cannot identify");
	//     }

	//     expect( failed		).to.be.true;
	// } finally {
	// }
    // });

    // it("should process signed-in request and respond", async () => {
	// try {
	//     await client.signIn( "someone@example.com", "Passw0rd!" );
	//     const agent_id		= client.agent_id;

	//     expect( agent_id		).to.equal("HcSCj43itVtGRr59tnbrryyX9URi6zpkzNKtYR96uJ5exqxdsmeO8iWKV59bomi");
	    
	//     conductor.general.once("call", async function ( data ) {
	// 	const keys		= Object.keys( data );

	// 	expect( keys.length		).to.equal( 4 );
	// 	expect( data["instance_id"]	).to.equal(`QmUgZ8e6xE1h9fH89CNqAXFQkkKyRh2Ag6jgTNC8wcoNYS::${agent_id}-holofuel`);
	// 	expect( data["zome"]		).to.equal("chat");
	// 	expect( data["function"]	).to.equal("list_channels");
	// 	expect( data["args"]		).to.be.an("object");

	// 	return ZomeAPIResult([]);
	//     });

	//     const response		= await client.callZomeFunction( "elemental-chat", "chat", "list_channels", { category: "General"} );
	//     log.debug("Response: %s", response );

	//     expect( response		).to.deep.equal( [] );
	// } finally {
	// }
    // });
    
    // it("should complete wormhole request", async () => {
	// try {
	//     conductor.general.once("call", async function ( data ) {
	// 	const signature		= await conductor.wormholeRequest( client.agent_id, "UW1ZVWo1NnJyakFTOHVRQXpkTlFoUHJ3WHhFeUJ4ZkFxdktwZ1g5bnBpOGZOeA==" );

	// 	expect( signature	).to.equal("w/lyO2IipA0sSdGtbg+5pACLoafOkdPRXXuiELis51HVthfhzdP2JZeIDQkwssMccC67mHjOuYsALe5DPQjKDw==");

	// 	return ZomeAPIResult(true);
	//     });

	//     const response		= await client.callZomeFunction( "elemental-chat", "chat", "list_channels", { category: "General"} );
	//     log.debug("Response: %s", response );

	//     expect( response		).to.be.true;
	// } finally {
	// }
    // });

    // it("should handle obscure error from Conductor", async () => {
	// try {
	//     Conductor.send_serialization_error	= true;
	//     // conductor.general.once("call", async function ( data ) {
	//     // 	return true;
	//     // });

	//     let failed				= false;
	//     try {
	// 	failed				= true;
	// 	const response			= await client.callZomeFunction( "elemental-chat", "chat", "list_channels", { category: "General"} );
	// 	log.debug("Response: %s", response );
	//     } catch ( err )  {
	// 	expect( err.message	).to.have.string("servicelogger.log_request threw");
	//     }

	//     expect( failed		).to.be.true;
	// } finally {
	// }
    // });

    // it("should have no pending confirmations", async () => {
	// try {
	//     expect( envoy.pending_confirms	).to.be.empty;
	// } finally {
	// }
    // });

    // it("should disconnect Envoy's websocket clients", async () => {
	// try {
	//     await conductor.stop();

	//     log.silly("Issuing zome call while conductor stoped");
	//     const request		= client.callZomeFunction( "elemental-chat", "chat", "list_channels", { category: "General"} );

	//     log.silly("Restart conductor");
	//     conductor			= new Conductor();
	//     conductor.general.once("call", async function ( data ) {
	// 	return ZomeAPIResult(true);
	//     });

	//     log.silly("Await zome call response");
	//     const response		= await request;
	//     log.debug("Response: %s", response );

	//     expect( response		).to.be.true;
	// } finally {
	// }
    // });
    
});
