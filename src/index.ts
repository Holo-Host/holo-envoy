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
const RPC_CLIENT_OPTS			= {
    "reconnect_interval": 1000,
    "max_reconnects": 30,
};
const CONDUCTOR_TIMEOUT			= RPC_CLIENT_OPTS.reconnect_interval * RPC_CLIENT_OPTS.max_reconnects;



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

	    this.conductor_master	= new WebSocket(`ws://localhost:${ifaces.master_port}`,  RPC_CLIENT_OPTS );
	    this.service_loggers	= new WebSocket(`ws://localhost:${ifaces.service_port}`, RPC_CLIENT_OPTS );
	    this.conductor		= new WebSocket(`ws://localhost:${ifaces.public_port}`,  RPC_CLIENT_OPTS );
	} catch ( err ) {
	    console.error( err );
	}

	this.connected			= Promise.all([
	    this.conductor_master.opened( CONDUCTOR_TIMEOUT ),
	    this.service_loggers.opened( CONDUCTOR_TIMEOUT ),
	    this.conductor.opened( CONDUCTOR_TIMEOUT ),
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

	this.ws_server.register("holo/wormhole/response", async ([ entry_id, signature ]) => {
	    log.debug("Reveived signing response #%s with signature %s", entry_id, signature );
	    
	    // - match entry ID to entry
	    const [entry,f,r]		= this.pending_entries[ entry_id ];

	    // - respond to HTTP request
	    f( signature );

	    // - return success
	    return true;
	});
	
	this.ws_server.register("holo/service/confirm", async ([ req_id, signature ]) => {
	    // - service logger confirmation
	    // - return success
	});

	this.ws_server.register("holo/call", async ({ anonymous, agent_id, signature, hash, hash_signature, payload }) => {
	    // Example of request package
	    // 
	    //     {
	    //         "anonymous"          : boolean,
	    //         "agent_id"           : string,
	    //         "signature"          : string,
	    //         "hash"               : string,
	    //         "hash_signature"     : string,
	    //         "payload"            : object,
	    //     }
	    //     
	    // - verify signature
	    // - service logger request
	    // - call conductor
	    const response		= await this.conductor.call("call", {
		"instance_id":	payload["instance_id"],
		"zome":		payload["zome"],
		"function":	payload["function"],
		"args":		payload["args"],
	    });
	    // - service logger response
	    // - return conductor response
	    return response;
	});
    }

    async startHTTPServer () {
	this.http_server		= http.createServer((req, res) => {
	    log.silly("Received wormhole request");
	    // Warn if method is not POST or Content-type is incorrect
	    req.pipe( concat_stream(async ( buffer ) => {
		try {
		    log.debug("Request buffer length: %s", buffer.length );
		    const { agent_id,
			    entry }	= JSON.parse( buffer.toString() );
		    
		    const signature	= await this.signingRequest( agent_id, entry );
		    
		    log.silly("Respond to wormhole request");
		    res.end( signature );
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

    signingRequest ( agent_id : string, entry : string ) {
	return new Promise((f,r) => {
	    const entry_id		= this.entry_counter++;
	    const event			= `${agent_id}/wormhole/request`;
	    
	    this.pending_entries[ entry_id ] = [ entry, f, r ];

	    log.debug("Send signing request #%s to Agent %s", entry_id, agent_id );
	    this.ws_server.emit( event, [ entry_id, entry ] );
	});
    }

}

export {
    Envoy
}
