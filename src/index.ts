import path				from 'path';
import logger				from '@whi/stdlog';
import { sprintf }			from 'sprintf-js';
import http				from 'http';
import crypto				from 'crypto';
import concat_stream			from 'concat-stream';
import SerializeJSON			from 'json-stable-stringify';
import { Codec }			from '@holo-host/cryptolib';
import { HcAdminWebSocket, HcAppWebSocket } from "../websocket-wrappers/holochain/client";
import { Server as WebSocketServer }		from './wss';
import { HHA_INSTALLED_APP_ID, SERVICELOGGER_INSTALLED_APP_ID } from './const';
import mocks				from './mocks';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

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
const READY_STATES			= ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

interface CallSpec {
    cell_id?	: string;
    zome_name?		: string;
    fn_name?		: string;
	payload?		: any;
	provenance?		: Buffer;
	cap?			: Buffer
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
	log.silly("Initializing Envoy with input: %s", opts );
	this.opts			= Object.assign({}, {
	    "port": WS_SERVER_PORT,
	    "NS": NAMESPACE,
	}, opts);
	log.normal("Initializing with port (%s) and namespace (%s)", this.opts.port, this.opts.NS );

	this.conductor_opts		= {
	    "interfaces": {
		"master_port":		1234, // conductor admin interface (adminPort) >>> NB: Currently set for holochain-run-dna - needs to be 4444
		"service_port":		42222, // servicelogger (happPort)
		"internal_port":	42233, //  self-hosted (happPort)
		"hosted_port":		42244,  // hosted (happPort)
	    },
	};

	this.connections();
	this.startWebsocketServer();
	this.startHTTPServer();
    }

    async connections () {
	try {
	    const ifaces		= this.conductor_opts.interfaces;		
	    this.hcc_clients.master	= await HcAdminWebSocket.init(`ws://localhost:${ifaces.master_port}`);
	    // this.hcc_clients.service	= await HcAppWebSocket.init(`ws://localhost:${ifaces.service_port}`);
	    // this.hcc_clients.internal	= await HcAppWebSocket.init(`ws://localhost:${ifaces.internal_port}`);
	    this.hcc_clients.hosted	= await HcAppWebSocket.init(`ws://localhost:${ifaces.hosted_port}`);
	} catch ( err ) {
	    console.error( err );
	}

	Object.keys( this.hcc_clients ).map(k => {
		this.hcc_clients[k].setSocketInfo({
			name: k,
			port: this.conductor_opts.interfaces[`${k}_port`]
		 });
	    log.info("Conductor client '%s' configured for port (%s)", k, this.hcc_clients[k].port );
	});

	const clients			= Object.values( this.hcc_clients );
	this.connected			= Promise.all(
	    clients.map(async (client:any) => {
		await client.opened( CONDUCTOR_TIMEOUT )
		    .catch( err => {
			log.fatal("Conductor client '%s' failed to connect: %s", client.checkConnection.name, String(err) );
			console.log( client.checkConnection.name, err );
			});
			
		// console.log('CLIENT SOCKET >>>>> ', client);	
		
		log.debug("Conductor client '%s' is 'CONNECTED': readyState = %s", client.checkConnection.name, client.checkConnection.socket.readyState );
	    })
	);

	await this.connected;
	log.normal("All Conductor clients are in a 'CONNECTED' state");
    }

	// --------------------------------------------------------------------------------------------

	// EVNOY WEBSOCKET SERVER

    async startWebsocketServer () {
	this.ws_server			= new WebSocketServer({
	    "port": this.opts.port,
	    "host": "0.0.0.0", // "localhost",
	});

	this.ws_server.on("connection", async (socket, request) => {
	    // path should contain the HHA ID and Agent ID so we can do some checks and alert the
	    // client-side if something is not right.
	    log.silly("Incoming connection from %s", request.url );
	    const url			= new URL( request.url, "http://localhost");

	    socket.on("message", (data) => {
		try {
		    log.silly("Incoming websocket message: %s", data );
		} catch (err) {
		    console.error( err );
		}
	    });

	    const anonymous		= url.searchParams.get('anonymous') === "true" ? true : false;
	    const agent_id		= url.searchParams.get('agent_id');
	    const hha_hash		= url.searchParams.get('hha_hash');
	    log.normal("%s (%s) connection for HHA ID: %s", anonymous ? "Anonymous" : "Agent", agent_id, hha_hash );

	    if ( anonymous ) {
		log.debug("Adding Agent (%s) to anonymous list with HHA ID %s", agent_id, hha_hash );
		this.anonymous_agents[ agent_id ]	= hha_hash;
	    }

	    socket.on("close", async () => {
		log.normal("Socket is closing for Agent (%s) using HHA ID %s", agent_id, hha_hash );

		if ( anonymous ) {
		    log.debug("Remove anonymous Agent (%s) from anonymous list", agent_id );
		    delete this.anonymous_agents[ agent_id ];
		}
	    });
	});

	this.ws_server.register("holo/wormhole/event", async ([ agent_id ]) => {
	    log.normal("Initializing wormhole setup for Agent (%s)", agent_id );
	    const event			= `${agent_id}/wormhole/request`;

	    try {
		log.debug("Registering RPC WebSocket event (%s) in namespace: %s", event, this.opts.NS );
		this.ws_server.event( event, this.opts.NS );
	    } catch (e) {
		if ( e.message.includes('Already registered event') )
		    log.warn("RPC WebSocket event '%s' is already registered for Agent (%s)", event, agent_id );
		else {
		    log.error("Failed during RPC WebSocket event registration: %s", String(e) );
		    console.error( e );
		}
	    }

	    return event;
	}, this.opts.NS );

	this.ws_server.register("holo/wormhole/response", async ([ payload_id, signature ]) => {
	    log.normal("Received signing response #%s with signature: %s", payload_id, signature );

	    // - match payload ID to payload
	    const [payload,f,r,toid]		= this.pending_signatures[ payload_id ];

	    // - respond to HTTP request
	    f( signature );

	    // clear fallback timeout response
	    clearTimeout( toid );

	    // - return success
	    return true;
	}, this.opts.NS );

	// Envoy - New Hosted Agent Sign-up Sequence
	this.ws_server.register("holo/agent/signup", async ([ hha_hash, agent_id ]) => {
	    log.normal("Received sign-up request from Agent (%s) for HHA ID: %s", agent_id, hha_hash )
	    const failure_response	= (new HoloError("Failed to create a new hosted agent")).toJSON();
	    let resp;

		log.info("Retreive HHA cell id using the Installed App Id: '%s'", HHA_INSTALLED_APP_ID);
		// TODO: Add cli param to holochain-run-dna that allows for agent specification - to use when creating cell_id.
	    const appInfo			= await this.callConductor( "internal", { installed_app_id: HHA_INSTALLED_APP_ID  });

	    if ( appInfo ) {
		log.error("Failed during HHA AppInfo lookup: %s", appInfo );
		return failure_response;
	    }

		const hha_cell_id			= appInfo.cell_data[0][0];

	    log.info("Look-up HHA record using ID '%s'", hha_hash );
	    resp			= await this.callConductor( "internal", {
		    "cell_id":	hha_cell_id,
		    "zome_name":		"hha",
		    "fn_name":		"get_happ",
			"payload":		{ "happ_id": hha_hash },
			"cap":		null,
			"provenance":	agent_id,
		});

	    if ( resp ) {
		log.error("Failed during App Details lookup in HHA: %s", resp );
		return failure_response;
	    }

		const app			= resp;
		const installed_app_id	= `${app.happ_alias}-${hha_hash}:${agent_id}`;

	    log.silly("HHA bundle: %s", app );
	    // Example response
		// {
		// 		happ_id: HeaderHash,
		// 		happ_bundle: {
		//			hosted_url: String,
		//			happ_alias: String,
		//			ui_path: String,
		//			name: String,
		//			dnas: [{
		//				hash: String, // hash of the dna, not a stored dht address
		//				path: String,
		//				nick: Option<String>, << make this required in hha!
		//			}],
		//		},
		// 		provider_pubkey: AgentPubKey,
		// }

	    log.info("Found %s DNA(s) for HHA ID (%s)", app.happ_bundle.dnas.length, hha_hash );
		let failed			= false;
			try {
				let status;
				// - Install App - This admin function creates cells for each dna (DNA/Agent instances) with associated nick, under the hood.
				try {				

				log.info("Installing HHA ID (%s) as Installed App ID (%s) ", hha_hash, installed_app_id );

				status			= await this.callConductor( "master", this.hcc_clients.master.installApp, {
					installed_app_id,
					agent_key: agent_id, // **This must be the agent pub key (from lair-client.js)**
					dnas: app.happ_bundle.dnas.map(dna => {
						const dnaFileName = dna.split("/");
						const nick = dna.nick || dnaFileName[dnaFileName.length - 1]
						return { nick, path: dna.path };
					  }),
				});
	

				if ( status.success !== true ) {
					log.error("Conductor 'installApp' returned non-success response: %s", status );
					failed		= true
					throw (new HoloError(`Failed to complete 'installApp' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "duplicate instance" ) )
					log.warn("Instance (%s) already exists in Conductor", installed_app_id );
					else {
						log.error("Failed during 'installApp': %s", String(err) );
						throw err;
					}
				}


				// Activate App -  Add the Installed App to a hosted interface.
				try {
				log.info("Adding instance (%s) to hosted interface", installed_app_id );
				status		= await this.callConductor( "master", this.hcc_clients.master.activateApp, { installed_app_id });

				if ( status.success !== true ) {
					log.error("Conductor 'activateApp' returned non-success response: %s", status );
					failed		= true
					throw (new HoloError(`Failed to complete 'activateApp' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "already in interface" ) )
					log.warn("Installed App ID (%s) is already added to hosted interface", installed_app_id );
				else {
					log.error("Failed during 'activateApp': %s", String(err) );
					throw err;
				}
				}


				// Attach App to Interface - Connect app to hosted interface and start app (ie: spin up all cells within app bundle)
				try {
				log.info("Starting instance (%s)", installed_app_id );
				status		= await this.callConductor( "master", this.hcc_clients.master.attachAppInterface, { port: this.conductor_opts.hosted_port });

				if ( status.success !== true ) {
					log.error("Conductor 'attachAppInterface' returned non-success response: %s", status );
					failed		= true
					throw (new HoloError(`Failed to complete 'attachAppInterface' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "already active" ) )
					log.warn("Instance (%s) already started", installed_app_id );
				else {
					log.error("Failed during 'attachAppInterface': %s", String(err) );
					throw err;
				}
				}

			} catch ( err ) {
				failed		= true;
				log.error("Failed during DNA processing for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, String(err) );
				console.log( err );
			}

	    if ( failed === true ) {
		// TODO: Rollback instances that were already created
		log.error("Failed during sign-up process for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, failure_response );
		return failure_response;
	    }

	    // - return success
	    log.normal("Completed sign-up process for Agent (%s) HHA ID (%s)", agent_id, hha_hash );
	    return true;
	}, this.opts.NS );


	// Chaperone Call to Envoy Server
	this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, service_signature }) => {
		// log.silly("Received request: %s", payload.call_spec );

		// TODO: REVISIT Payload after updated for RSM and ensure validity
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
	    //                 "cell_id"  	  : string
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
		// QUESTION: Will we still be passing a  `dna_alias`, or should we reference the `installed_app_id` instead?
	    log.normal("Received zome call request from Agent (%s) with spec: %s::%s->%s( %s )",
		       agent_id, call_spec.dna_alias, call_spec.zome_name, call_spec.fn_name, Object.keys(call_spec.payload).join(", ") );

	    // - service logger request. If the servicelogger.log_{request/response} fail (eg. due
	    // to bad signatures, wrong host_id, or whatever), then the request cannot proceed, and
	    // we'll immediately return an error w/o a response_id or result.
	    let req_log_hash;

	    try {
		log.debug("Log service request (%s) from Agent (%s)", service_signature, agent_id );
		req_log_hash		= await this.logServiceRequest( hha_hash, agent_id, payload, service_signature );
		log.info("Service request log hash: %s", req_log_hash );
	    } catch ( err ) {
		const error		= `servicelogger.log_request threw: ${String(err)}`;
		log.error("Failed during service request log: %s", error );
		console.error( err );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }

	    // ZomeCall to Conductor App Interface
	    let response, holo_error;
	    try {		
		// NOTE: ZomeCall Structure (UPDATED) = { 
			// cell_id,
			// zome_name,
			// fn_name,
			// payload
			// cap,
			// provenance
		// }
		log.debug("Calling zome function %s::%s->%s( %s ) on cell_id (%s) with %s arguments, cap token (%s), and provenance (%s):", () => [
			call_spec.zome_name, call_spec.fn_name, call_spec.cell_id, Object.entries(call_spec.payload).map(([k,v]) => `${k} : ${typeof v}`).join(", "), call_spec.cap, call_spec.provenance ]);

		response		= await this.callConductor( "hosted", {
		    "cell_id":	call_spec["cell_id"],
		    "zome_name":		call_spec["zome"],
		    "fn_name":		call_spec["function"],
			"payload":		call_spec["args"],
			"cap":		null, // this will pass for calls in which the agent has Unrestricted status (includes all calls to own chain)
			"provenance":	agent_id,
		});
	    } catch ( err ) {
		log.error("Failed during Conductor call: %s", String(err) );
		response		= {};

		if ( err.message.includes("Failed to get signatures from Client") ) {
		    let new_message		= anonymous === true
			? "Agent is not signed-in"
			: "We were unable to contact Chaperone for the Agent signing service.  Please check ...";

		    log.warn("Setting error response to wormhole error message: %s", new_message  );
		    holo_error			= (new HoloError(new_message)).toJSON();
		}
		else if ( err instanceof HoloError ) {
		    log.warn("Setting error response to raised HoloError: %s", String(err) );
		    holo_error		= err.toJSON();
		}
		else {
		    log.fatal("Conductor call threw unknown error: %s", String(err) );
		    console.error( err );
		    holo_error		= {
			"name": err.name,
			"message": err.message,
		    };
		}
	    }

	    const entries		= [];
	    const metrics		= {
		"duration": "1s",
	    };
	    // - service logger response
	    let res_log_hash;

	    try {
		log.debug("Log service response (%s) for request (%s)", req_log_hash, service_signature );
		res_log_hash		= await this.logServiceResponse( hha_hash, req_log_hash, response, metrics, entries );
		log.info("Service response log hash: %s", res_log_hash );
	    } catch ( err ) {
		const error		= `servicelogger.log_response threw: ${String(err)}`;
		log.error("Failed during service response log: %s", error );
		console.error( err );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }

	    if ( typeof res_log_hash === "string" ) {
		log.info("Adding service response ID (%s) to waiting list for client confirmations", res_log_hash );
		this.addPendingConfirmation( res_log_hash, agent_id, hha_hash );
	    }

	    // - return conductor response
	    log.normal("Returning reponse (%s) for request (%s): result : %s, error : %s",
		       res_log_hash, service_signature, typeof response, typeof holo_error );
	    return {
		"response_id": res_log_hash,
		"result": response,
		"error": holo_error,
	    };
	}, this.opts.NS );

	// Servicelogger Call to Envoy Server (with request confirmation)
	this.ws_server.register("holo/service/confirm", async ([ resp_id, payload, signature ]) => {
	    log.normal("Received confirmation request for response (%s)", resp_id );
	    if ( typeof resp_id !== "string" ) {
		log.error("Invalid type '%s' for response ID, should be of type 'string'", typeof resp_id );
		return false;
	    }

	    // - service logger confirmation
	    const { agent_id,
		    hha_hash }		= this.getPendingConfirmation( resp_id );

	    let service_log;
	    try {
		log.debug("Log service confirmation (%s) for response (%s)", signature, resp_id );
		service_log		= await this.logServiceConfirmation( hha_hash, agent_id, resp_id, payload, signature );
		log.info("Service confirmation log hash: %s", service_log );
	    } catch ( err ) {
		const error		= `servicelogger.log_service threw: ${String(err)}`
		log.error("Failed during service confirmation log: %s", error );
		console.error( err );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }

	    this.removePendingConfirmation( resp_id );

	    // - return success
	    log.normal("Response (%s) confirmation is complete", resp_id );
	    return true;
	}, this.opts.NS );
    }

	// --------------------------------------------------------------------------------------------

	// WORMHOLE HTTP SERVER

    async startHTTPServer () {
	let wormhole_counter		= 0;
	function prefix (msg) {
	    return `\x1b[95mWORMHOLE #${wormhole_counter}: \x1b[0m` + msg;
	}

	this.http_server		= http.createServer(async (req, res) => {
	    let whid			= wormhole_counter++;
	    log.silly(prefix("Received wormhole %s request with content length: %s"), req.method, req.headers["content-length"] );

	    // Warn if method is not POST or Content-type is incorrect
	    const body : string		= await httpRequestStream( req );
	    log.debug(prefix("Actually HTTP body length: %s"), body.length );
	    log.silly(prefix("HTTP Body: %s"), body );

	    let agent_id, payload, signature;
	    try {
		let data		= JSON.parse(body);
		agent_id		= data.agent_id;
		payload			= data.payload;
	    } catch ( err ) {
		log.error(prefix("Failed to handle HTTP request: %s"), err );
		log.silly(prefix("HTTP Request: %s"), body );
	    }

	    try {
		log.debug(prefix("Conductor needs Agent (%s) to sign payload: %s"), agent_id, payload );
		signature	= await this.signingRequest( agent_id, payload );
	    } catch ( err ) {
		log.error("WORMHOLE #%s: Signing request error: %s", wormhole_counter, String(err) );
		res.writeHead(400);
		res.end(`${err.name}: ${err.message}`);
	    }

	    log.silly(prefix("Returning signature (%s) for payload: %s"), signature, payload );
	    res.end( signature );
	});
	this.http_server.on('clientError', (err, socket) => {
	    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
	});
	this.http_server.listen( WH_SERVER_PORT );
    }

    async close () {
	log.normal("Initiating shutdown; closing Conductor clients, RPC WebSocket server, then HTTP server");

	const clients			= Object.values( this.hcc_clients );
	clients.map( (client:any) => client.close() );

	await Promise.all( clients.map( (client:any) => client.closed() ));
	log.info("All Conductor clients are closed");

	await this.ws_server.close();
	log.info("RPC WebSocket server is closed");

	await this.http_server.close();
	log.info("HTTP server is closed");
    }

    signingRequest ( agent_id : string, payload : string, timeout = 5_000 ) {
	const payload_id		= this.payload_counter++;
	log.normal("Opening a request (#%s) for Agent (%s) signature of payload: typeof '%s'", payload_id, agent_id, typeof payload );

	return new Promise((f,r) => {
	    const event			= `${agent_id}/wormhole/request`;

	    if ( this.ws_server.eventList( this.opts.NS ).includes( event ) === false ) {
		log.warn("Trying to get signature from unknown Agent (%s)", agent_id );
		if ( Object.keys( this.anonymous_agents ).includes( agent_id ) )
		    throw new Error(`Agent ${agent_id} cannot sign requests because they are anonymous`);
		else
		    throw new Error(`Agent ${agent_id} is not registered.  Something must have broke?`);
	    }

	    let toid			= setTimeout(() => {
		log.error("Failed during signing request #%s with timeout (%sms)", payload_id, timeout );
		r("Failed to get signature from Chaperone")
	    }, timeout );

	    log.info("Adding signature request #%s to pending signatures", payload_id );
	    this.pending_signatures[ payload_id ] = [ payload, f, r, toid ];

	    this.ws_server.emit( event, [ payload_id, payload ] );
	    log.normal("Sent signing request #%s to Agent (%s)", payload_id, agent_id );
	});
    }

	// --------------------------------------------------------------------------------------------

	 // Conductor Call Handling

    async callConductor ( client, call_spec, args : any = {} ) {
		log.normal("Received request to call Conductor using client '%s' with call spec: typeof '%s'", client, typeof call_spec );
		let interfaceMethod, callAgent;
		try {
			if ( typeof client === "string" )
			client			= this.hcc_clients[ client ];

			let ready_state		= client.socket.readyState;
			if ( ready_state !== 1 ) {
			log.silly("Waiting for 'CONNECTED' state because current ready state is %s (%s)", ready_state, READY_STATES[ready_state] );
			await client.opened();
			}

			// Assume the interfaceMethod is using the one of the AppWebsocket Instances as interfaceMethod, unless `call_spec` is a function (already pulled from the Master AdminWebsocket Innstance..).
			interfaceMethod			= this.hcc_clients[client].callZome;
			callAgent = 'app'
			if ( call_spec instanceof Function) {
			log.debug("Admin Call spec details: %s( %s )", () => [
				call_spec, Object.entries(args).map(([k,v]) => `${k} : ${typeof v}`).join(", ") ]);
			interfaceMethod			= call_spec;
			callAgent 				= 'admin'
			}
			else if (Object.keys(call_spec).length >= 2 ) {
				log.debug("App Info Call spec details for installed app id ( %s )", () => [
					call_spec.installed_app_id ]);
				args					= call_spec;
				interfaceMethod			= this.hcc_clients[client].appInfo;
			}
			else {
			// NOTE: ZomeCall Structure (UPDATED) = { cap: null, cell_id: rootState.appInterface.cellId, zome_name, fn_name, provenance: rootState.agentKey, payload }
			log.debug("Zome Call spec details - called with cap token (%s) and provenance (%s): \n%s::%s->%s( %s )", () => [
				call_spec.cap, call_spec.provenance, call_spec.cell_id, call_spec.zome_name, call_spec.fn_name, Object.entries(call_spec.payload).map(([k,v]) => `${k} : ${typeof v}`).join(", ") ]);
			args			= call_spec;
			}
		} catch ( err ) {
			console.log("callConductor preamble threw", err );
		throw new HoloError("callConductor preamble threw error: %s", String(err));
		}

		let resp;
		try {
			if ( ['hha'].includes( args.zome_name ) ) {
			log.warn("Calling mock '%s' instead using client '%s'", args.cell_id, client.checkConnection.name );
			log.silly("Mock input: %s", JSON.stringify(args,null,4) );
			resp			= await mocks( args );
			}
			else {
			log.silly("Calling Conductor method (%s) over client '%s' with input: %s", interfaceMethod, client.checkConnection.name, JSON.stringify(args,null,4) );
			resp			= await interfaceMethod( args );

			if ( callAgent === "app" ) {
				if ( typeof resp !== "string" )
				// NB: this should be updated to refect the BUFFER....
				log.warn("Expected zome call result to be 'string', not '%s'", typeof resp );
				else {
				let resp_length	= resp.length;
				resp		= JSON.parse(resp);
				log.debug("Parsed zome call response (length %s) to typeof '%s'", resp_length, typeof resp );
				}
			}
		}
	} catch ( err ) {
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
		if ( err.data.includes("response from service is not success") ) {
		    log.error("Failed during Conductor call because of a signing request error: %s", err.data );
		    throw new HoloError("Failed to get signatures from Client");
		}
		else {
		    log.fatal("Failed during Conductor call with RPC Internal Error: %s -> %s", err.message, err.data );
		    throw new HoloError("Unknown -32000 Error: %s", JSON.stringify( err ));
		}
	    } else if ( err instanceof Error ) {
		log.error("Failed during Conductor call with error: %s", String(err) );
		throw new HoloError(String(err));
	    } else {
		log.fatal("Failed during Conductor call with unknown error: %s", err );
		throw new HoloError("Unknown RPC Error: %s", JSON.stringify( err ));
	    }
	}

	log.normal("Call returned successful response: typeof '%s'", typeof resp );
	return resp;
    }


	// --------------------------------------------------------------------------------------------

    // Service Logger Methods

    addPendingConfirmation ( res_log_hash, agent_id, hha_hash ) {
	log.info("Add response (%s) to pending confirmations with Agent/HHA: %s/%s", res_log_hash, agent_id, hha_hash );
	this.pending_confirms[ res_log_hash ] = {
	    agent_id,
	    hha_hash,
	};
    }

    getPendingConfirmation ( res_log_hash ) {
	log.info("Get response (%s) from pending confirmations", res_log_hash );
	return this.pending_confirms[ res_log_hash ];
    }

    removePendingConfirmation ( res_log_hash ) {
	log.info("Remove response (%s) from pending confirmations", res_log_hash );
	delete this.pending_confirms[ res_log_hash ];
    }

	// TODO: REMOVE CALL(to update with rsm)
    async logServiceRequest ( hha_hash, agent_id, payload, signature ) {
	log.normal("Processing service logger request (%s)", signature );
	const call_spec			= payload.call_spec;
	const args_hash			= digest( call_spec["payload"] );

	log.debug("Using argument digest: %s", args_hash );
	// NB: Update servicelogger to expect `happ_alias` instead of  `dna_alias` in the request payload
	const request			= {
	    "timestamp":	payload.timestamp,
	    "host_id":		payload.host_id,
	    "call_spec": {
		"hha_hash":	call_spec["hha_hash"],
		"happ_alias":	call_spec["happ_alias"], // << should we use the installed_app_id instead?
		"zome":		call_spec["zome_name"],
		"function":	call_spec["fn_name"],
		"args_hash":	args_hash,
	    },
	};

	log.silly("Recording service request from Agent (%s) with signature (%s)\n%s", agent_id, signature, JSON.stringify( request, null, 4 ));
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

	if ( resp ) {
	    log.info("Returning success response for request log (%s): typeof '%s'", signature, typeof resp );
	    return resp;
	}
	else if ( resp ) {
	    log.error("Service request log (%s) returned non-success response: %s", signature, resp );
	    let err			= JSON.parse( resp.Internal );
	    throw new Error( JSON.stringify(err,null,4) );
	}
	else {
	    log.fatal("Service request log (%s) returned unknown response format: %s", signature, resp );
	    let content			= typeof resp === "string" ? resp : `keys? ${Object.keys(resp)}`;
	    throw new Error(`Unknown 'service->log_request' response format: typeof '${typeof resp}' (${content})`);
	}
    }

	// TODO: REMOVE CALL (to update with rsm)
    async logServiceResponse ( hha_hash, request_log_hash, response, metrics, entries ) {
	const response_hash		= digest( response );
	log.normal("Processing service logger response (%s) for request (%s)", response_hash, request_log_hash );

	log.silly("Recording service response (%s) with metrics: %s", response_hash, metrics );
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

	if ( resp ) {
	    log.info("Returning success response for response log (%s): typeof '%s'", response_hash, typeof resp );
	    return resp;
	}
	else if ( resp ) {
	    log.error("Service response log (%s) returned non-success response: %s", response_hash, resp );
	    let err			= JSON.parse( resp.Internal );
	    throw new Error( JSON.stringify(err,null,4) );
	}
	else {
	    log.fatal("Service response log (%s) returned unknown response format: %s", response_hash, resp );
	    let content			= typeof resp === "string" ? resp : `keys? ${Object.keys(resp)}`;
	    throw new Error(`Unknown 'service->log_response' response format: typeof '${typeof resp}' (${content})`);
	}
    }

	// TODO: Update this call (this will become the single call to servicelogger)
    async logServiceConfirmation ( hha_hash, agent_id, response_commit, confirmation_payload, signature ) {
		log.normal("Processing service logger confirmation (%s) for response (%s)", signature, response_commit );


		log.info("Retreive Servicelogger cell id using the Installed App Id: '%s'", SERVICELOGGER_INSTALLED_APP_ID);
		// TODO: Add cli param to holochain-run-dna that allows for agent specification - to use when creating cell_id.
		const appInfo			= await this.callConductor( "internal", { installed_app_id: SERVICELOGGER_INSTALLED_APP_ID });

		if ( appInfo ) {
		log.error("Failed during Servicelogger AppInfo lookup: %s", appInfo );
		return (new HoloError("Failed to fetch AppInfo for Servicelogger")).toJSON();
		}

		const servicelogger_cell_id			= appInfo.cell_data[0][0];

		log.silly("Recording service confirmation (%s) with payload: %s", signature, confirmation_payload );
		const resp			= await this.callConductor( "service", {
			"cell_id":	servicelogger_cell_id,
			"zome_name":		"service",
			"fn_name":		"log_activity",
			"payload":		{
				"activity":	{
					"request":	'', // ClientRequest,
					"response": '', // HostResponse,
					"confirmation":	''	// Confirmation,
				}
			},
			cap: null,
			provenance: agent_id
		});

		if ( resp ) {
			log.info("Returning success response for confirmation log (%s): typeof '%s'", signature, typeof resp );
			return resp;
		}
		else if ( resp ) {
			log.error("Service confirmation log (%s) returned non-success response: %s", signature, resp );
			let err			= JSON.parse( resp.Internal );
			throw new Error( JSON.stringify(err,null,4) );
		}
		else {
			log.fatal("Service confirmation log (%s) returned unknown response format: %s", signature, resp );
			let content			= typeof resp === "string" ? resp : `keys? ${Object.keys(resp)}`;
			throw new Error(`Unknown 'service->log_service' response format: typeof '${typeof resp}' (${content})`);
		}
    }

}


async function httpRequestStream ( req ) : Promise<string> {
    return new Promise((f,r) => {
	req.pipe( concat_stream(async ( buffer ) => {
	    try {
		f( buffer.toString() );
	    } catch ( err ) {
		r( err );
	    }
	}));
    });
}


export {
    Envoy
}
