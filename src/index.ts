import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

import http				from 'http';
import concat_stream			from 'concat-stream';
import { Server as WebSocketServer,
	 Client as WebSocket }		from './wss';

const WS_SERVER_PORT			= 4656; // holo
const WH_SERVER_PORT			= 9676; // worm



class Envoy {
    ws_server		: any;
    http_server		: any;
    opts		: any;
    conductor_opts	: any;
    connected		: any;

    request_counter	: number	= 0;
    entry_counter	: number	= 0;
    pending_requests	: object	= {};
    pending_entries	: object	= {};

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

	this.connections();
	this.startWebsocketServer();
	this.startHTTPServer();
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

    async startWebsocketServer () {
	this.ws_server			= new WebSocketServer({
	    "port": this.opts.port,
	    "host": "localhost",
	});
	
	this.ws_server.on("connection", async (socket, request) => {
	    // path should contain the HHA ID and Agent ID so we can do some checks and alert the
	    // client-side if something is not right.
	    log.info("URL: %s", request.url );
	    const url			= new URL( request.url, "http://localhost");

	    const agent_id		= url.searchParams.get('agent');
	    const hha_hash		= url.searchParams.get('hha_hash');
	});

	this.ws_server.register("holo/agent/identify", async ([ agent_id ]) => {
	    log.debug("Initializing Agent: %s", agent_id );
	    const event			= `${agent_id}/wormhole/request`;

	    try {
		this.ws_server.event( event );
	    } catch (e) {
		if ( e.message.includes('Already registered event') )
		    log.warn("Agent '%s' is already registered", agent_id );
		else
		    console.error( e );
	    }
	    
	    return event;
	});
	
	this.ws_server.register("holo/agent/signup", async ([ hha_hash, agent_id ]) => {
	    // - create hosted agent
	    // - create DNA/Agent instances
	    // - add instances to general interface
	    // - start instances
	    // - return success
	});

	this.ws_server.register("holo/wormhole/response", async function ([ entry_id, signature ]) {
	    // - match entry ID to entry
	    // - respond to HTTP request
	    // - return success
	});
	
	this.ws_server.register("holo/service/confirm", async function ([ req_id, signature ]) {
	    // - service logger confirmation
	    // - return success
	});

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

    async startHTTPServer () {
	this.http_server		= http.createServer((req, res) => {
	    log.silly("Received wormhole request");
	    req.pipe( concat_stream(( buffer ) => {
		try {
		    log.debug("Request buffer length: %s", buffer.length );
		    let data		= JSON.parse( buffer.toString() );
		    log.silly("Request data: %s", data );
		    
		    log.silly("Respond to wormhole request");
		    res.end( "signature" );
		} catch ( err ) {
		    console.error( err );
		}
	    }));
	});
	this.http_server.on('clientError', (err, socket) => {
	    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
	});
	this.http_server.listen( WH_SERVER_PORT );
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

	log.info("Closing HTTP server...");
	await this.http_server.close();
    }

    async sendSigningRequest ( agent_id, entry ) {
	const entry_id			= this.entry_counter++;
	const event			= `${agent_id}/wormhole/request`;

	this.pending_entries[ entry_id ] = entry;

	this.ws_server.emit( event, [ entry_id, entry ] );
    }

}

export {
    Envoy
}
