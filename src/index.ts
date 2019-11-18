import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

import { Server as WebSocketServer,
	 Client as WebSocket }		from './wss';

const WS_SERVER_PORT			= 4656;



class Envoy {
    ws_server		: any;
    
    sign_req_counter	: number	= 0;
    pending_signatures	: object	= {};
    
    constructor ( port = WS_SERVER_PORT ) {
	this.ws_server			= new WebSocketServer({
	    "port": port,
	    "host": "localhost",
	});

	this.listen();
	this.registerEndpoints();
    }

    async listen () {
	this.ws_server.on("connection", async (socket, request) => {
	    
	});
    }

    async registerEndpoints () {

	// wss.register('holo/identify', a => this.identifyAgent(a))
	// // TODO: something in here to update the agent key subscription? i.e. re-identify?
	// wss.register('holo/agents/new', a => this.newHostedAgent(a))
	this.ws_server.register("holo/register/agent", async function ( agent_id ) {
	    log.debug("Registered new Agent: %s", agent_id );

	    try {
		this.ws_server.event( `${agent_id}/wormhole/request` );
	    } catch (e) {
		if ( e.message.includes('Already registered event') )
		    log.warn("Agent '%s' is already registered", agent_id );
		else
		    throw e
	    }
	    
	});

	// wss.register('holo/clientSignature', a => this.wormholeSignature(a))  // TODO: deprecated
	// wss.register('holo/wormholeSignature', a => this.wormholeSignature(a))
	// wss.register('holo/serviceSignature', a => this.serviceSignature(a))
	this.ws_server.register("holo/wormhole/response", async function ([ id, signature ]) {
	    
	});

	// wss.register('holo/call', a => this.zomeCall(a))
	this.ws_server.register("holo/call", async ({ agent_id, signature, payload }) => {
	    // - verify signature
	    // - service logger request
	    // - call conductor
	    // - service logger response
	    // - return conductor response
	    return "Hello World";
	});
    }

    async sendSigningRequest ( agent_id, entry ) {
	const req_id			= this.sign_req_counter++;
	const event			= `${agent_id}/wormhole/request`;

	this.pending_signatures[ req_id ] = entry;
	
	this.ws_server.emit( event, [ req_id, entry ] );
    }

    async close () {
	await this.ws_server.close();
    }

}

export {
    Envoy
}
