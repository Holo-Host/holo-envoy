import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

import http				from 'http';
import concat_stream			from 'concat-stream';
import SerializeJSON			from 'json-stable-stringify';
import { KeyManager }			from '@holo-host/wasm-key-manager';
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
    pending_confirms	: object	= {};
    pending_entries	: object	= {};

    hcc_clients		: any		= {};

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

	    this.hcc_clients.master	= new WebSocket(`ws://localhost:${ifaces.master_port}`,  RPC_CLIENT_OPTS );
	    this.hcc_clients.service	= new WebSocket(`ws://localhost:${ifaces.service_port}`, RPC_CLIENT_OPTS );
	    this.hcc_clients.general	= new WebSocket(`ws://localhost:${ifaces.public_port}`,  RPC_CLIENT_OPTS );
	} catch ( err ) {
	    console.error( err );
	}

	const clients			= Object.values( this.hcc_clients );
	this.connected			= Promise.all( clients.map( (client:any) => client.opened( CONDUCTOR_TIMEOUT ) ))
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
	
	this.ws_server.register("holo/service/confirm", async ([ resp_id, payload, signature ]) => {
	    log.info("Processing pending confirmation: %s", resp_id );
	    
	    // - service logger confirmation
	    const { agent_id,
		    hha_hash }		= this.getPendingConfirmation( resp_id );
	    const service_log_hash	= await this.logServiceConfirmation( hha_hash, agent_id, resp_id, payload, signature )
	    
	    this.removePendingConfirmation( resp_id );

	    // - return success
	    return true;
	});

	this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, signature }) => {
	    // Example of request package
	    // 
	    //     {
	    //         "anonymous"            : boolean,
	    //         "agent_id"             : string,
	    //         "payload": {
	    //             "timestamp"        : string,
	    //             "host_id"          : string,
	    //             "hha_hash"         : string,
	    //             "dna_alias"        : string,
	    //             "call_spec": {
	    //                 "instance_id"  : string
	    //                 "zome"         : string
	    //                 "function"     : string
	    //                 "args"         : array
	    //                 "args_hash"    : string
	    //             }
	    //         }
	    //         "signature"            : string,
	    //     }
	    //
	    const call_spec		= payload.call_spec;
	    const hha_hash		= payload.hha_hash;

	    // - service logger request
	    const req_log_hash		= await this.logServiceRequest( hha_hash, agent_id, payload, signature );
	    
	    // - call conductor
	    const response		= await this.callConductor( "general", {
		"instance_id":	call_spec["instance_id"],
		"zome":		call_spec["zome"],
		"function":	call_spec["function"],
		"args":		call_spec["args"],
	    });

	    const entries		= [];
	    const metrics		= {};
	    // - service logger response
	    const res_log_hash		= await this.logServiceResponse( hha_hash, req_log_hash, response, metrics, entries );

	    log.debug("Request  log commit hash: %s", req_log_hash );
	    log.debug("Response log commit hash: %s", res_log_hash );

	    this.addPendingConfirmation( res_log_hash, agent_id, hha_hash );
	    
	    // - return conductor response
	    return {
		"response_id": res_log_hash,
		"result": response,
	    };
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

	const clients			= Object.values( this.hcc_clients );
	clients.map( (client:any) => client.close() );

	await Promise.all( clients.map( (client:any) => client.closed() ));

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
    
    async callConductor ( client, call_spec ) {
	if ( typeof client === "string" )
	    client			= this.hcc_clients[ client ];
	
	const resp			= await client.call("call", call_spec );

	if ( resp.error )
	    throw new Error(`${resp.error}: ${resp.message}`);

	return resp;
    }

    // Service Logger Methods

    addPendingConfirmation ( res_log_hash, agent_id, hha_hash ) {
	log.debug("Add pending confirmation: %s", res_log_hash );
	this.pending_confirms[ res_log_hash ] = {
	    agent_id,
	    hha_hash,
	};
    }

    getPendingConfirmation ( res_log_hash ) {
	return this.pending_confirms[ res_log_hash ];
    }
    
    removePendingConfirmation ( res_log_hash ) {
	log.debug("Remove pending confirmation: %s", res_log_hash );
	delete this.pending_confirms[ res_log_hash ];
    }

    async logServiceRequest ( hha_hash, agent_id, payload, signature ) {
	const call_spec			= payload.call_spec;
	
	return await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::service_logger`,
	    "zome":		"service",
	    "function":		"log_request",
	    "args":		{
		"agent_id": agent_id,
		"request": [
		    payload.timestamp,
		    payload.host_id,
		    [
			payload.hha_hash,
			payload.dna_alias,
			call_spec["zome"],
			call_spec["function"],
			call_spec["args_hash"],
		    ]
		],
		"signature": signature,
	    },
	});
    }

    async logServiceResponse ( hha_hash, request_log_hash, response, metrics, entries ) {
	const response_digest		= KeyManager.digest( SerializeJSON( response ) );
	const response_hash		= KeyManager.encodeDigest( response_digest );
	
	return await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::service_logger`,
	    "zome":		"service",
	    "function":		"log_response",
	    "args":		{
		"request_commit":	request_log_hash,
		"response_hash":	response_hash,
		"metrics":		metrics,
		"entries":		entries,
	    },
	});
    }

    async logServiceConfirmation ( hha_hash, agent_id, response_commit, confirmation_payload, signature ) {
	return await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::service_logger`,
	    "zome":		"service",
	    "function":		"log_service",
	    "args":		{
		"agent_id":		agent_id,
		"response_commit":	response_commit,
		"confirmation":		confirmation_payload,
		"signature":		signature,
	    },
	});
    }

}

export {
    Envoy
}
