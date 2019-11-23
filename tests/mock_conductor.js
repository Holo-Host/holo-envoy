const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


const { Server : WebSocketServer,
	Client : WebSocket }		= require('../build/wss.js');
const fetch				= require('node-fetch');
const { KeyManager }			= require('@holo-host/chaperone');
const SerializeJSON			= require('json-stable-stringify');


const MockServiceLogger = {
    "verifyRequestPackage": ( agent_id, request, signature ) => {
	const serialized		= JSON.stringify( request );
	const sig_bytes			= KeyManager.decodeSignature( signature );

	return KeyManager.verifyWithAgentId( serialized, sig_bytes, agent_id );
    },

    "service": {
	async log_request ( args ) {
	    const { agent_id,
		    request,
		    signature }		= args;

	    if ( this.verifyRequestPackage( agent_id, request, signature ) !== true )
		throw new Error("Signature does not match request package");

	    const entry			= SerializeJSON( args );
	    return KeyManager.encodeDigest( KeyManager.digest( entry ) );
	},
	
	async log_response ( args ) {
	    const entry			= SerializeJSON( args );
	    return KeyManager.encodeDigest( KeyManager.digest( entry ) );
	}
    }
};


class Conductor {

    constructor () {
	this.wormhole_port		= 9676;
	
	this.master			= new WebSocketServer({
	    "port": 42211,
	    "host": "localhost",
	});
	this.service			= new WebSocketServer({
	    "port": 42222,
	    "host": "localhost",
	});
	this.internal			= new WebSocketServer({
	    "port": 42233,
	    "host": "localhost",
	});
	this.general			= new WebSocketServer({
	    "port": 42244,
	    "host": "localhost",
	});

	this.handleServiceLogs();
    }

    handleServiceLogs () {
	this.service.register("call", async function ( call_spec ) {
	    // TODO: Validate call_spec format
	    // TODO: Check if instance_id is registered/running
	    
	    const zome			= MockServiceLogger[ call_spec["zome"] ];
	    const func			= zome[ call_spec["function"] ];

	    return await func.call( MockServiceLogger, call_spec["args"] );
	});
    }

    async stop () {
	await this.master.close();
	await this.service.close();
	await this.internal.close();
	await this.general.close();
    }

    async wormholeRequest ( agent_id, entry ) {
	const message			= typeof entry === "string" ? entry : JSON.stringify( entry );
	const resp			= await fetch(`http://localhost:${this.wormhole_port}`, {
	    "method": "POST",
	    "body": JSON.stringify({
		"agent_id": agent_id,
		"payload": message,
	    }),
	    "timeout": 1000,
	});

	return resp.text();
    }
    
}

module.exports				= Conductor;
