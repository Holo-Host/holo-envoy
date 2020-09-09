import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

import crypto				from 'crypto';
import http				from 'http';
import concat_stream			from 'concat-stream';
import SerializeJSON			from 'json-stable-stringify';
import { Codec }			from '@holo-host/cryptolib';
import { sprintf }			from 'sprintf-js';
import { Server as WebSocketServer,
	 Client as WebSocket }		from './wss';
import mocks				from './mocks';


const sha256				= (buf) => crypto.createHash('sha256').update( Buffer.from(buf) ).digest();
const digest				= (data) => Codec.Digest.encode( sha256( typeof data === "string" ? data : SerializeJSON( data ) ));

const WS_SERVER_PORT			= 4656; // holo
const WH_SERVER_PORT			= 9676; // worm
const RPC_CLIENT_OPTS			= {
    "reconnect_interval": 1000,
    "max_reconnects": 300,
};
const CONDUCTOR_TIMEOUT			= RPC_CLIENT_OPTS.reconnect_interval * RPC_CLIENT_OPTS.max_reconnects;
const NAMESPACE				= "/hosting/";

interface CallSpec {
    instance_id?	: string;
    zome?		: string;
    function?		: string;
    args?		: any;
}


class HoloError extends Error {

    constructor( message, ...params ) {
	if ( params.length > 0 )
	    message			= sprintf(message, ...params );

	// Pass remaining arguments (including vendor specific ones) to parent constructor
	super( message );

	// Maintains proper stack trace for where our error was thrown (only available on V8)
	if ( Error.captureStackTrace ) {
	    Error.captureStackTrace( this, HoloError );
	}

	this.name			= 'HoloError';

	// Fix for Typescript
	//   - https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
	Object.setPrototypeOf( this, HoloError.prototype );
    }

    toJSON () {
	return {
	    "name": this.name,
	    "message": this.message,
	};
    }
}


class Envoy {
    ws_server		: any;
    http_server		: any;
    opts		: any;
    conductor_opts	: any;
    connected		: any;

    request_counter	: number	= 0;
    payload_counter	: number	= 0;
    pending_confirms	: object	= {};
    pending_signatures	: object	= {};
    anonymous_agents	: any		= {};

    hcc_clients		: any		= {};

    constructor ( opts ) {
	this.opts			= Object.assign({}, {
	    "port": WS_SERVER_PORT,
	    "NS": NAMESPACE,
	}, opts);

	this.conductor_opts		= {
	    "interfaces": {
		"master_port":		42211,
		"service_port":		42222,
		"internal_port":	42233,
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

	    this.hcc_clients.master	= new WebSocket(`ws://localhost:${ifaces.master_port}`,   RPC_CLIENT_OPTS );
	    this.hcc_clients.service	= new WebSocket(`ws://localhost:${ifaces.service_port}`,  RPC_CLIENT_OPTS );
	    this.hcc_clients.internal	= new WebSocket(`ws://localhost:${ifaces.internal_port}`, RPC_CLIENT_OPTS );
	    this.hcc_clients.hosted	= new WebSocket(`ws://localhost:${ifaces.public_port}`,   RPC_CLIENT_OPTS );
	} catch ( err ) {
	    console.error( err );
	}

	Object.keys( this.hcc_clients ).map(k => {
	    this.hcc_clients[k].name = k;
	});

	const clients			= Object.values( this.hcc_clients );
	this.connected			= Promise.all(
	    clients.map( (client:any) => {
		return client.opened( CONDUCTOR_TIMEOUT )
		    .catch( err => console.log( client.name, err ) );
	    })
	);
    }

    async startWebsocketServer () {
	this.ws_server			= new WebSocketServer({
	    "port": this.opts.port,
	    "host": "0.0.0.0", // "localhost",
	});

	this.ws_server.on("connection", async (socket, request) => {
	    // path should contain the HHA ID and Agent ID so we can do some checks and alert the
	    // client-side if something is not right.
	    log.info("URL: %s", request.url );
	    const url			= new URL( request.url, "http://localhost");

	    socket.on("message", (data) => {
		try {
		    log.silly("Socket incoming: %s", data );
		} catch (err) {
		    console.error( err );
		}
	    });

	    const anonymous		= url.searchParams.get('anonymous') === "true" ? true : false;
	    const agent_id		= url.searchParams.get('agent_id');
	    const hha_hash		= url.searchParams.get('hha_hash');

	    if ( anonymous ) {
		log.debug("Adding Agent %s to anonymous list for hApp %s", agent_id, hha_hash );
		this.anonymous_agents[ agent_id ]	= hha_hash;

		socket.on("close", async () => {
		    log.debug("Remove Agent %s from anonymous list", agent_id, hha_hash );
		    delete this.anonymous_agents[ agent_id ];
		});
	    }
	});

	this.ws_server.register("holo/wormhole/event", async ([ agent_id ]) => {
	    log.debug("Initializing Agent: %s", agent_id );
	    const event			= `${agent_id}/wormhole/request`;

	    try {
		this.ws_server.event( event, this.opts.NS );
	    } catch (e) {
		if ( e.message.includes('Already registered event') )
		    log.warn("Event '%s' is already registered", agent_id );
		else
		    console.error( e );
	    }

	    return event;
	}, this.opts.NS );

	this.ws_server.register("holo/wormhole/response", async ([ payload_id, signature ]) => {
	    log.debug("Reveived signing response #%s with signature %s", payload_id, signature );

	    // - match payload ID to payload
	    const [payload,f,r]		= this.pending_signatures[ payload_id ];

	    // - respond to HTTP request
	    f( signature );

	    // - return success
	    return true;
	}, this.opts.NS );

	this.ws_server.register("holo/agent/identify", async ([ agent_id ]) => {
	    // Check if this agent is known to this host
	    try {
		log.info("Fetching agent list");
		let agents		= await this.callConductor( "master", "admin/agent/list" );

		// Example response
		//
		//     [{
		//         "id":"host-agent",
		//         "name":"Host Agent",
		//         "public_address":"HcSCIk4TB9g386Ooeo49yH57VFPer6Guhcd5BY8j8wyRjjwmZFKW3mkxZs3oghr",
		//         "keystore_file":"/var/lib/holochain-conductor/holo",
		//         "holo_remote_key":null,
		//         "test_agent":null
		//     }]
		//

		log.debug("Agent list: {}", agents );
		const agent		= agents.find( agent => agent.public_address === agent_id );

		if ( agent === undefined ) {
		    log.error("Unknown to this Host: {}", agent_id );
		    return (new HoloError("Agent '%s' is unknown to this Host", agent_id )).toJSON();
		}
	    } catch ( err ) {
		console.error( err );
		log.error("Check for hosting state of Agent %s failed with: %s", agent_id, String(err) );
		return (new HoloError( String(err) )).toJSON();
	    }

	    return true;
	}, this.opts.NS );
	
	this.ws_server.register("holo/agent/signup", async ([ hha_hash, agent_id ]) => {
	    const failure_response	= (new HoloError("Failed to create a new hosted agent")).toJSON();
	    let resp;

	    // - add new hosted agent
	    try {
		log.info("Add new hosted agent '%s' with holo_remote_key", agent_id );
		const status	= await this.callConductor( "master", "admin/agent/add", {
		    "id":		agent_id,
		    "name":		agent_id,
		    "holo_remote_key":	agent_id,
		});

		if ( status.success !== true )
		    return (new HoloError("Failed to add hosted agent")).toJSON();
	    } catch ( err ) {
		if ( err.message.includes( "already exists" ) )
		    log.warn("Agent %s already exists", agent_id );
		else
		    throw err;
	    }

	    // - look-up happ store hash
	    log.info("Look-up hApp Store hash for HHA Hash '%s'", hha_hash );
	    resp			= await this.callConductor( "internal", {
		"instance_id":	"holo-hosting-app",
		"zome":		"provider",
		"function":	"get_app_details",
		"args":		{
		    "app_hash": hha_hash,
		},
	    });

	    if ( resp.Err ) {
		log.error("HHA lookup failed: %s", resp.Err );
		return failure_response;
	    }

	    const app			= resp.Ok;
	    // Example response
	    //
	    //     {
	    //         "app_bundle": {
	    //             "happ_hash": "<happ store address>",
	    //         },
	    //         "payment_pref": [{
	    //             "provider_address":         Address,
	    //             "dna_bundle_hash":          HashString,
	    //             "max_fuel_per_invoice":     f64,
	    //             "max_unpaid_value":         f64,
	    //             "price_per_unit":           f64,
	    //         }],
	    //     }
	    //

	    // - get DNA list
	    log.info("Look-up hApp details for hash '%s'", app.app_bundle.happ_hash );
	    resp			= await this.callConductor( "internal", {
		"instance_id":	"happ-store",
		"zome":		"happs",
		"function":	"get_app",
		"args":		{
		    "app_hash": app.app_bundle.happ_hash,
		},
	    });

	    if ( resp.Err ) {
		log.error("HHA lookup failed: %s", resp.Err );
		return failure_response;
	    }

	    const happ			= resp.Ok;
	    // Example response
	    //
	    //     {
	    //         "address":              Address,
	    //         "app_entry": {
	    //             "title":            String,
	    //             "author":           String,
	    //             "description":      String,
	    //             "thumbnail_url":    String,
	    //             "homepage_url":     String,
	    //             "dnas": [{
	    //                 "location":     String,
	    //                 "hash":         HashString,
	    //                 "handle":       Option<String>,
	    //             }],
	    //             "ui":               Option<AppResource>,
	    //         },
	    //         "upvotes":              i32,
	    //         "upvoted_by_me":        bool,
	    //     }
	    //

	    log.info("Starting %s DNAs for new Agent", happ.app_entry.dnas.length );
	    let failed			= false;
	    for ( let dna of happ.app_entry.dnas ) {
		const instance_id	= `${hha_hash}::${agent_id}-${dna.handle}`;
		const storage		= `/var/lib/holochain-conductor/storage/${instance_id}/`;

		try {
		    let status;

		    // - create DNA/Agent instances
		    try {
			log.debug("Create instance '%s' with storage path: %s", instance_id, storage );
			status		= await this.callConductor( "master", "admin/instance/add", {
			    "id":		instance_id,
			    "dna_id":	dna.handle,
			    "agent_id":	agent_id,
			    "storage":	"file",
			});
			log.debug("Call conductor response: %s", status );

			if ( status.success !== true ) {
			    failed		= true
			    break;
			}
		    } catch ( err ) {
			if ( err.message.toLowerCase().includes( "duplicate instance" ) )
			    log.warn("Instance ID %s already exists", instance_id );
			else
			    throw err;
		    }

		    
		    // - add instances to hosted interface
		    try {
			log.debug("Add instance '%s' to hosted interface", instance_id );
			status		= await this.callConductor( "master", "admin/interface/add_instance", {
			    "interface_id":	"hosted-interface",
			    "instance_id":	instance_id,
			    // "alias":		instance_id,
			});
			log.debug("Call conductor response: %s", status );
			
			if ( status.success !== true ) {
			    failed		= true
			    break;
			}
		    } catch ( err ) {
			if ( err.message.toLowerCase().includes( "already in interface" ) )
			    log.warn("Instance ID %s already added to hosted interface", instance_id );
			else
			    throw err;
		    }

		    
		    // - start instances
		    try {
			log.debug("Start instance: %s", instance_id );
			status		= await this.callConductor( "master", "admin/instance/start", {
			    "id":		instance_id,
			});
			log.debug("Call conductor response: %s", status );

			if ( status.success !== true ) {
			    failed		= true
			    break;
			}
		    } catch ( err ) {
			if ( err.message.toLowerCase().includes( "already active" ) )
			    log.warn("Instance ID %s already started", instance_id );
			else
			    throw err;
		    }
			
		} catch ( err ) {
		    failed		= true;
		    console.log( err );
		}
	    }

	    if ( failed === true ) {
		// TODO: Rollback instances that were already created
		return failure_response;
	    }

	    // - return success
	    return true;
	}, this.opts.NS );


	this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, service_signature }) => {
	    log.silly("Received request: %s", payload.call_spec );
	    // Example of request package
	    // 
	    //     {
	    //         "anonymous"            : boolean,
	    //         "agent_id"             : string,
	    //         "payload": {
	    //             "timestamp"        : string,
	    //             "host_id"          : string,
	    //             "call_spec": {
	    //                 "hha_hash"     : string,
	    //                 "dna_alias"    : string,
	    //                 "instance_id"  : string
	    //                 "zome"         : string
	    //                 "function"     : string
	    //                 "args"         : array
	    //             }
	    //         }
	    //         "service_signature"    : string,
	    //     }
	    //
	    const call_spec		= payload.call_spec;
	    const hha_hash		= call_spec.hha_hash;


	    // - service logger request. If the servicelogger.log_{request/response} fail (eg. due
	    // to bad signatures, wrong host_id, or whatever), then the request cannot proceed, and
	    // we'll immediately return an error w/o a response_id or result.
	    let req_log;
	    let req_log_hash;
	    
	    try {
		req_log			= await this.logServiceRequest( hha_hash, agent_id, payload, service_signature );
		log.debug( req_log );

		req_log_hash	    	= req_log;
		log.debug("Request log commit hash: %s", req_log_hash );
	    } catch ( err ) {
		const error		= `servicelogger.log_request failed: ${String(err)}`;
		log.warn("log service request commit failed: %s", error );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }
	    
	    // - call conductor
	    let response, holo_error;
	    try {
		response		= await this.callConductor( "hosted", {
		    "instance_id":	call_spec["instance_id"],
		    "zome":		call_spec["zome"],
		    "function":		call_spec["function"],
		    "args":		call_spec["args"],
		});
	    } catch ( err ) {
		log.error("Conductor call threw: %s", String(err) );
		response		= {};

		if ( err.message.includes("Failed to get signatures from Client") ) {
		    let new_message	= "We were unable to contact Chaperone for the Agent signing service.  Please check ...";
		    if ( anonymous === true )
			new_message		= "Agent is not signed-in";

		    holo_error			= (new HoloError(new_message)).toJSON();
		}
		else if ( err instanceof HoloError )
		    holo_error		= err.toJSON();
		else
		    holo_error		= {
			"name": err.name,
			"message": err.message,
		    };
	    }

	    const entries		= [];
	    const metrics		= {
		"duration": "1s",
	    };
	    // - service logger response
	    let res_log;
	    let res_log_hash;
	    
	    try {
		res_log		= await this.logServiceResponse( hha_hash, req_log_hash, response, metrics, entries );
		log.debug( res_log );
		
		res_log_hash		= res_log;
		log.debug("Response log commit hash: %s", res_log_hash );
	    } catch ( err ) {
		const error		= `servicelogger.log_response failed: ${String(err)}`;
		log.warn("log service response commit failed: %s", error );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }

	    if ( typeof res_log_hash === "string" )
		this.addPendingConfirmation( res_log_hash, agent_id, hha_hash );
	    
	    // - return conductor response
	    return {
		"response_id": res_log_hash,
		"result": response,
		"error": holo_error,
	    };
	}, this.opts.NS );
	
	this.ws_server.register("holo/service/confirm", async ([ resp_id, payload, signature ]) => {
	    log.info("Processing pending confirmation: %s", resp_id );
	    if ( typeof resp_id !== "string" )
		return false;
	    
	    // - service logger confirmation
	    const { agent_id,
		    hha_hash }		= this.getPendingConfirmation( resp_id );

	    let service_log;
	    try {
		service_log		= await this.logServiceConfirmation( hha_hash, agent_id, resp_id, payload, signature );
		log.debug( service_log );
	    } catch ( err ) {
		const error		= `servicelogger.log_service failed: ${String(err)}`
		log.warn("log service confirm commit failed: %s", error );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }
	    
	    this.removePendingConfirmation( resp_id );

	    // - return success
	    return true;
	}, this.opts.NS );
    }

    async startHTTPServer () {
	this.http_server		= http.createServer((req, res) => {
	    log.silly("Received wormhole request");
	    // Warn if method is not POST or Content-type is incorrect
	    req.pipe( concat_stream(async ( buffer ) => {
		try {
		    log.debug("Request buffer length: %s", buffer.length );
		    log.silly("HTTP Body: %s", buffer.toString() );
		    const { agent_id,
			    payload }	= JSON.parse( buffer.toString() );

		    let signature;
		    try {
			log.silly("Body payload: %s", payload );
			signature	= await this.signingRequest( agent_id, payload );
		    } catch ( err ) {
			log.error("Signing request error: %s", String(err) );
			res.writeHead(400);
			res.end(`${err.name}: ${err.message}`);
		    }
		    
		    log.silly("Respond to wormhole request");
		    res.end( signature );
		} catch ( err ) {
		    log.error("Failed to handle HTTP request: %s", err );
		    log.silly("HTTP Request: %s", buffer.toString() );
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

    signingRequest ( agent_id : string, payload : string, timeout = 5_000 ) {
	return new Promise((f,r) => {
	    const payload_id		= this.payload_counter++;
	    const event			= `${agent_id}/wormhole/request`;

	    if ( this.ws_server.eventList( this.opts.NS ).includes( event ) === false ) {
		if ( Object.keys( this.anonymous_agents ).includes( agent_id ) )
		    throw new Error(`Agent ${agent_id} cannot sign requests because they are anonymous`);
		else
		    throw new Error(`Agent ${agent_id} is not registered.  Something must have broke?`);
	    }
	    
	    this.pending_signatures[ payload_id ] = [ payload, f, r ];

	    setTimeout(() => r("Failed to get signature from Chaperone"), timeout );

	    log.debug("Send signing request #%s to Agent %s", payload_id, agent_id );
	    this.ws_server.emit( event, [ payload_id, payload ] );
	});
    }
    
    async callConductor ( client, call_spec, args : any = {} ) {
	let method;
	try {
	    if ( typeof client === "string" )
		client			= this.hcc_clients[ client ];

	    log.silly("Waiting for opened state: %s", client.socket.readyState );
	    await client.opened();

	    // Assume the method is "call" unless `call_spec` is a string.
	    method			= "call";
	    if ( typeof call_spec === "string" ) {
		log.info("Calling method %s( %s )", call_spec, args );
		method			= call_spec;
	    }
	    else {
		log.info(
		    "Calling zome function %s:%s->%s( %s )",
		    call_spec.instance_id,
		    call_spec.zome,
		    call_spec.function,
		    typeof call_spec.args,
		);
		args			= call_spec;
	    }
	} catch ( err ) {
	    console.log("callConductor preamble threw", err );
	}

	let resp;
	try {
	    if ( ["holo-hosting-app", "happ-store"].includes( args.instance_id ) )
		resp			= await mocks( args );
	    else {
		log.debug("Input of conductor call %s: %s", method, JSON.stringify(args,null,4) );
		resp			= await client.call( method, args );
	    }

	    try {
		resp			= JSON.parse(resp);
	    } catch ( err ) {
		null;
	    }
	
	} catch ( err ) {
	    console.log("callConductor threw", err );
	    // -32700
	    //     Parse errorInvalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
	    // -32600
	    //     Invalid RequestThe JSON sent is not a valid Request object.
	    // -32601
	    //     Method not foundThe method does not exist / is not available.
	    // -32602
	    //     Invalid paramsInvalid method parameter(s).
	    // -32603
	    //     Internal errorInternal JSON-RPC error.
	    // -32000 to -32099
	    //     Server errorReserved for implementation-defined server-errors.
	    if ( err.code === -32000 ) {
		log.error("RPC Error '%s': %s", err.message, err.data );
		if ( err.data.includes("response from service is not success") )
		    throw new HoloError("Failed to get signatures from Client");
		else
		    throw new HoloError("Unknown -32000 Error: %s", JSON.stringify( err ));
	    } else if ( err instanceof Error ) {
		throw new HoloError(String(err));
	    } else {
		throw new HoloError("Unknown RPC Error: %s", JSON.stringify( err ));
	    }
	}

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
	const args_hash			= digest( call_spec["args"] );
	const request			= {
	    "timestamp":	payload.timestamp,
	    "host_id":		payload.host_id,
	    "call_spec": {
		"hha_hash":	call_spec["hha_hash"],
		"dna_alias":	call_spec["dna_alias"],
		"zome":		call_spec["zome"],
		"function":	call_spec["function"],
		"args_hash":	args_hash,
	    },
	};

	log.silly("%s", JSON.stringify( request, null, 4 ));
	log.silly("%s", SerializeJSON( request ));
	
	const resp			= await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::servicelogger`,
	    "zome":		"service",
	    "function":		"log_request",
	    "args":		{
		"agent_id":		agent_id,
		"request":		request,
		"request_signature":	signature,
	    },
	});
	
	log.silly("Log Service Request response: %s", JSON.stringify( resp ));
	if ( resp.Ok )
	    return resp.Ok;
	else if ( resp.Err ) {
	    log.silly("resp.Err: %s", resp.Err );
	    let err			= JSON.parse( resp.Err.Internal );
	    throw new Error( JSON.stringify(err,null,4) );
	}
	else
	    throw new Error(`Unknown service logger response format: ${JSON.stringify(resp)}`);
    }

    async logServiceResponse ( hha_hash, request_log_hash, response, metrics, entries ) {
	const response_digest		= sha256( SerializeJSON( response ) );
	const response_hash		= Codec.Digest.encode( response_digest );
	
	const resp			= await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::servicelogger`,
	    "zome":		"service",
	    "function":		"log_response",
	    "args":		{
		"request_commit":	request_log_hash,
		"response_hash":	response_hash,
		"host_metrics":		metrics,
		"entries":		entries,
	    },
	});

	log.silly("Log Service Response response: %s", JSON.stringify( resp ));
	if ( resp.Ok )
	    return resp.Ok;
	else if ( resp.Err ) {
	    log.silly("resp.Err: %s", resp.Err );
	    let err			= JSON.parse( resp.Err.Internal );
	    throw new Error( JSON.stringify(err,null,4) );
	}
	else
	    throw new Error(`Unknown service logger response format: ${JSON.stringify(resp)}`);
    }

    async logServiceConfirmation ( hha_hash, agent_id, response_commit, confirmation_payload, signature ) {
	const resp			= await this.callConductor( "service", {
	    "instance_id":	`${hha_hash}::servicelogger`,
	    "zome":		"service",
	    "function":		"log_service",
	    "args":		{
		"agent_id":		agent_id,
		"response_commit":	response_commit,
		"confirmation":		confirmation_payload,
		"confirmation_signature": signature,
	    },
	});

	log.silly("Log Service Confirmation response: %s", JSON.stringify( resp ));
	if ( resp.Ok )
	    return resp.Ok;
	else if ( resp.Err ) {
	    log.silly("resp.Err: %s", resp.Err );
	    let err			= JSON.parse( resp.Err.Internal );
	    throw new Error( JSON.stringify(err,null,4) );
	}
	else
	    throw new Error(`Unknown service logger response format: ${JSON.stringify(resp)}`);
    }

}

export {
    Envoy
}
