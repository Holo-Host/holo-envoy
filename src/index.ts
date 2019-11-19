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
    opts		: any;
    conductor_opts	: any;
    connected		: any;

    sign_req_counter	: number	= 0;
    pending_signatures	: object	= {};

    conductor		: any;
    conductor_master	: any;
    service_loggers	: any;


    constructor ( opts ) {
	this.opts			= Object.assign({}, {
	    "port": WS_SERVER_PORT
	}, opts);

	this.conductor_opts		= {
	    "interfaces": {
		"master_port":		42211,
		"service_port":		42222,
		// "internal_port":	42233, // Used by HP Admin, not by Envoy
		"public_port":		42244,
	    },
	};

	this.ws_server			= new WebSocketServer({
	    "port": this.opts.port,
	    "host": "localhost",
	});

	this.config();
	this.connections();
    }

    async config () {
	this.ws_server.on("connection", async (socket, request) => {
	    
	});

	await this.registerEndpoints();
    }

    async registerEndpoints () {
	// wss.register('holo/identify', a => this.identifyAgent(a))
	// // TODO: something in here to update the agent key subscription? i.e. re-identify?
	// wss.register('holo/agents/new', a => this.newHostedAgent(a))
	this.ws_server.register("holo/register/agent", async ( agent_id ) => {
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
	    const response		= await this.conductor.call("call", payload );
	    // - service logger response
	    // - return conductor response
	    return response;
	});
    }

    async connections () {
	try {
	    const ifaces		= this.conductor_opts.interfaces;

	    this.conductor_master	= new WebSocket(`ws://localhost:${ifaces.master_port}`);
	    this.service_loggers	= new WebSocket(`ws://localhost:${ifaces.service_port}`);
	    this.conductor		= new WebSocket(`ws://localhost:${ifaces.public_port}`);
	} catch ( err ) {
	    console.error( err );
	}

	this.connected			= Promise.all([
	    this.conductor_master.opened(),
	    this.service_loggers.opened(),
	    this.conductor.opened(),
	]);
    }

    async sendSigningRequest ( agent_id, entry ) {
	const req_id			= this.sign_req_counter++;
	const event			= `${agent_id}/wormhole/request`;

	this.pending_signatures[ req_id ] = entry;

	this.ws_server.emit( event, [ req_id, entry ] );
    }

    async close () {
	log.info("Closing Conductor clients...");

	this.conductor_master.close();
	this.service_loggers.close();
	this.conductor.close();

	await Promise.all([
	    this.conductor_master.closed(),
	    this.service_loggers.closed(),
	    this.conductor.closed(),
	]);

	log.info("Closing WebSocket server...");
	await this.ws_server.close();
    }

}

export {
    Envoy
}
