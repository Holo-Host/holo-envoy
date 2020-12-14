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
import { Console } from 'console';

const TEST_NUMER = 9;

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

export const base64FromBuffer = (buffer) => {
	var binary = "";
	var bytes = new Uint8Array(buffer);
	var len = bytes.byteLength;
	for (var i = 0; i < len; i++) {
	  binary += String.fromCharCode(bytes[i]);
	}
	const base64 = Buffer.from(binary, 'binary').toString('base64')
	return base64;
};

const bufferFromBase64 = (base64) => {
	console.log('\n Base64 Data to Encode as Buffer : ', base64);
	var byteString = Buffer.from(base64, 'base64').toString('binary');
	const buffer = Buffer.alloc(byteString.length); //  new Uint8Array
	
	for(let i = 0; i < byteString.length; i++) {
		buffer[i] = byteString.charCodeAt(i);
	}
	console.log('\n Encoded Buffer : ', buffer);
	console.log('\n');
	return buffer;
};

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
	hha_hash	: string;
	dna_alias	: string;
	cell_id?	: string;
    zome?		: string;
    function?		: string;
	args?		: any;
}

interface AppDna {
	path: string;
	nick?: string;
}

interface EnvoyConfig {
	mode: number;
	port?: number;
	NS?: string;
	hosted_app_dnas?: [AppDna];
	hosted_port_number?: number;
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
    opts		: EnvoyConfig;
    conductor_opts	: any;
    connected		: any;

    request_counter	: number	= 0;
    payload_counter	: number	= 0;
    pending_confirms	: object	= {};
    pending_signatures	: object	= {};
	anonymous_agents	: any		= {};

	hcc_clients		: any		= {};
	
	static PRODUCT_MODE	: number		= 0;
	static DEVELOP_MODE	: number		= 1;
	static DEFAULT_OPTS					= {
		mode: Envoy.PRODUCT_MODE,
	}

    constructor ( opts: EnvoyConfig = Envoy.DEFAULT_OPTS ) {
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
	    this.hcc_clients.service	= await HcAppWebSocket.init(`ws://localhost:${ifaces.service_port}`);
	    this.hcc_clients.internal	= await HcAppWebSocket.init(`ws://localhost:${ifaces.internal_port}`);
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
			
		console.log('CLIENT SOCKET >>>>> ', client);	
		
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
	    const appInfo			= await this.callConductor( "internal", { installed_app_id: HHA_INSTALLED_APP_ID  });

	    if ( !appInfo ) {
		log.error("Failed during HHA AppInfo lookup: %s", appInfo );
		return failure_response;
	    }

		const hha_cell_id			= appInfo.cell_data[0][0];
		const host_agent_id = hha_cell_id[1];

	    // log.info("Look-up Hosted App's HHA record using ID '%s'", hha_hash );
	    // resp			= await this.callConductor( "internal", {
		//     "cell_id":	hha_cell_id,
		//     "zome_name":		"hha",
		//     "fn_name":		"get_happs",
		// 	"payload":		null,
		// 	"cap":		null,
		// 	"provenance": host_agent_id,
		// });

	    // if ( !resp ) {
		// log.error("Failed during App Details lookup in HHA: %s", resp );
		// return failure_response;
	    // }

		// const app			= resp[0];
		// TODO: REMOVE ONCE DONE testing 'hha as the web user's hosted app'
		const app 				= { happ_bundle: { dnas: [{ nick: '', path: '' }] } }
		const installed_app_id	= `hosted-app-${hha_hash}:${agent_id}`;

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

	    log.info("Found %s DNA(s) for App with HHA ID (%s)", app.happ_bundle.dnas.length, hha_hash );
		
		const buffer_agent_id = await bufferFromBase64(agent_id);	
		console.log('\nDecoded agent ID', agent_id);

		log.info("Encoded Agent ID (%s) into buffer form: %s", agent_id, buffer_agent_id );
		console.log('\n')
		
		let failed			= false;
			try {
				let adminResponse;
				// - Install App - This admin function creates cells for each dna with associated nick, under the hood.
				try {				

				log.info("Installing App with HHA ID (%s) as Installed App ID (%s) ", hha_hash, installed_app_id );

				console.log('\nAGENT PUB KEY >>> : ', buffer_agent_id);
				console.log('\n');
				
				console.log('this.opts.mode', this.opts.mode)
				console.log('\n');

				let dnas;
				if (this.opts.hosted_app_dnas && this.opts.mode === Envoy.DEVELOP_MODE) {
					dnas = this.opts.hosted_app_dnas;
				}

				adminResponse			= await this.callConductor( "master", this.hcc_clients.master.installApp, {
					installed_app_id,
					agent_key: buffer_agent_id, // <<<< !!
					dnas: dnas || app.happ_bundle.dnas.map(dna => {
						let nick;
						if (!dna.nick) {
							const dnaFileName = dna.path.split("/");
							nick = dnaFileName[dnaFileName.length - 1]
						} else {
							nick = dna.nick
						}
						return { nick, path: dna.path };
					  }),
				});

				if ( adminResponse.type !== "success" ) {
					log.error("Conductor 'installApp' returned non-success response: %s", adminResponse );
					failed		= true
					throw (new HoloError(`Failed to complete 'installApp' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "duplicate cell" ) )
					log.warn("Cell (%s) already exists in Conductor", installed_app_id );
					else {
						log.error("Failed during 'installApp': %s", String(err) );
						throw err;
					}
				}

				// Activate App -  Add the Installed App to a hosted interface.
				try {
				log.info("Activating Installed App (%s)", installed_app_id );
				adminResponse		= await this.callConductor( "master", this.hcc_clients.master.activateApp, { installed_app_id });

				if ( adminResponse.type !== "success" ) {
					log.error("Conductor 'activateApp' returned non-success response: %s", adminResponse );
					failed		= true
					throw (new HoloError(`Failed to complete 'activateApp' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "already in interface" ) )
					log.warn("Cannot Activate App: Installed App ID (%s) is already added to hosted interface", installed_app_id );
				else {
					log.error("Failed during 'activateApp': %s", String(err) );
					throw err;
				}
				}

				// Attach App to Interface - Connect app to hosted interface and start app (ie: spin up all cells within app bundle)
				try {
				let hosted_port
				
				if ( (this.opts.hosted_port_number === 0 || this.opts.hosted_port_number) && this.opts.mode === Envoy.DEVELOP_MODE) {
					hosted_port = this.opts.hosted_port_number;
				} else {
					hosted_port = this.conductor_opts.interfaces.hosted_port;
				}

				log.info("Starting installed-app (%s) on port (%s)", installed_app_id, hosted_port );
				
				adminResponse		= await this.callConductor( "master", this.hcc_clients.master.attachAppInterface, { port: hosted_port });

				if ( adminResponse.type !== "success" ) {
					log.error("Conductor 'attachAppInterface' returned non-success response: %s", adminResponse );
					failed		= true
					throw (new HoloError(`Failed to complete 'attachAppInterface' for installed_app_id'${installed_app_id}'.`)).toJSON();
				}
				} catch ( err ) {
				if ( err.message.toLowerCase().includes( "already active" ) )
					log.warn("Cannot Start App: Intalled-app (%s) is already started", installed_app_id );
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
		// TODO: Rollback cells that were already created << check to see if is already being done in core.
		log.error("Failed during sign-up process for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, failure_response );
		return failure_response;
	    }

	    // - return success
	    log.normal("Completed sign-up process for Agent (%s) HHA ID (%s)", agent_id, hha_hash );
	    return true;
	}, this.opts.NS );

	
	// Chaperone AppInfo Call to Envoy Server
	this.ws_server.register("holo/app-info", async ({ installed_app_id }) => {
		const call_id = this.request_counter;
		this.request_counter++;

		let appInfo
		try {
			log.debug("Calling AppInfo function with installed_app_id(%s) :", installed_app_id);
			appInfo			= await this.callConductor( "internal", { installed_app_id }); // TODO: update to call "hosted" port once hc-run-dna is updated to install multiple apps per conductor... (Ditto for line 542 - hosted app ZomeCall)
			
			if ( !appInfo ) {
				log.error("Conductor call 'appInfo' returned non-success response: %s", appInfo );
				throw new HoloError(`Failed to call 'appInfo' for installed_app_id'${installed_app_id}'.`);
			}
		} catch ( err ) {
		log.error("Failed during Conductor AppInfo call: %s", String(err) );
		throw err;
		}

		log.normal("Completed AppInfo call for installed_app_id (%s)", installed_app_id);
		console.log('appInfo stringified : ', JSON.stringify(appInfo))
		
		return {
			"response_id": call_id,
			"type": "success",
			"payload": appInfo // JSON.stringify(appInfo);
		}
	}, this.opts.NS );

	
	// Chaperone ZomeCall to Envoy Server
	this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, service_signature }) => {
		console.log('INCOMING ZOME CALL REQUEST ... ')
		console.log('REQUEST INFO : ', { anonymous, agent_id, payload, service_signature });
		
		const call_id = this.request_counter;
		this.request_counter++;

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
		//				   "dna_alias"	  : string,
	    //                 "cell_id"  	  : string,
	    //                 "zome"         : string,
	    //                 "function"     : string,
		//                 "args"         : array
	    //             }
	    //         }
	    //         "service_signature"    : string,
	    //     }
		//
		
		const call_spec		= payload.call_spec;
		const call_spec_args = (typeof call_spec.args === "object") ? Object.keys(call_spec.args).join(", ") : call_spec.args;
	    log.normal("Received zome call request from Agent (%s) with spec: %s::%s->%s( %s )",
		       agent_id, call_spec.cell_id, call_spec.zome, call_spec.function, call_spec_args );

	    // - Servicelogger request. If the servicelogger.log_{request/response} fail (eg. due
	    // to bad signatures, wrong host_id, or whatever), then the request cannot proceed, and
	    // we'll immediately return an error w/o a response_id or result.
	    let request;

		log.debug("Log service request (%s) from Agent (%s)", service_signature, agent_id );
		request		= await this.logServiceRequest( agent_id, payload, service_signature );

		console.log('ABOUT TO MAKE ACTUAL ZOME CALL....');

	    // ZomeCall to Conductor App Interface
	    let zomeCall_response, holo_error
	    try {
		const buffer_agent_id = await bufferFromBase64(agent_id);	
		const zomeCallArgs = (typeof call_spec.args === 'object') ? Object.entries(call_spec.args).map(([k,v]) => `${k} : ${typeof v}`).join(", ") : call_spec.args
		log.debug("Calling zome function %s->%s( %s ) on cell_id (%s), cap token (%s), and provenance (%s):", () => [
			call_spec.zome, call_spec.function, zomeCallArgs, call_spec.cell_id, null, agent_id ]);

			// NOTE: ZomeCall Structure (UPDATED) = { 
				// cell_id,
				// zome_name,
				// fn_name,
				// payload
				// cap,
				// provenance
			// }

			const changeCellIdType = (cellId, fn) => cellId.map(cellHash => fn(cellHash.data));
			const decodedHostedCellId = changeCellIdType(call_spec["cell_id"], base64FromBuffer);
			const encodedCellIds = [bufferFromBase64(decodedHostedCellId[0]), bufferFromBase64(decodedHostedCellId[1])];
			// console.log('DECODED CELL IDS: ', decodedHostedCellId);
			// console.log('ENCODED CELL IDS: ', encodedCellIds);
			
			zomeCall_response		= await this.callConductor( "internal", { // TODO: update to hosted once hc-run-dna tool can install/run multiple apps... (Ditto for line 450 - AppInfo call)
		    "cell_id":	encodedCellIds, // call_spec["cell_id"], // TODO: >> Learn why we can't just pass in the cell_id in type received back from appInfo call? 
		    "zome_name":		call_spec["zome"],
		    "fn_name":		call_spec["function"],
			"payload":		null, // TODO: call_spec["args"], >>> update back... && remember why sending a payload doesn't work here... but does when sent by ui (elemental-chat-ui)....????
			"cap":		null, // Note: this will pass for calls in which the agent has Unrestricted status (includes all calls to own chain)
			"provenance":	buffer_agent_id,
		});
	    } catch ( err ) {
		log.error("Failed during Conductor call: %s", String(err) );
		zomeCall_response		= {};

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

		const metrics		= {
		"response_received": [165303,0],
		"cpu": '7'
	    };
	    // - service logger response
	    let host_response;

		log.debug("Form service response for signed request (%s): %s", service_signature, JSON.stringify( request, null, 4 ));
		host_response		= await this.logServiceResponse( zomeCall_response, metrics );
		log.info("Service response by Host: %s",  JSON.stringify( host_response, null, 4 ) );

		// Use call_id to act as waiting ID
		log.info("Adding service call ID (%s) to waiting list for client confirmations", call_id );
		this.addPendingConfirmation( call_id, request, host_response, agent_id );

	    // - return host response
	    log.normal("Returning reponse (%s) for request (%s) with signature (%s), error : %s",
			host_response, request, service_signature, holo_error);

		return {
			// TODO: Update chaperone to expect new response callsig
			"response_id": call_id,
			"type": "success",
			"payload": host_response
		}
	}, this.opts.NS );

	// Chaperone Call to Envoy Server to confirm service
	this.ws_server.register("holo/service/confirm", async ([ response_id, response_signature, confirmation ]) => {
	    log.normal("Received confirmation request for zome call response (%s)", response_id );
	    if ( typeof response_id !== "number" ) {
		log.error("Invalid type '%s' for response ID, should be of type 'string'", typeof response_id );
		return false;
	    }

	    // - service logger confirmation
	    const { agent_id,
			client_req, host_res }		= this.getPendingConfirmation( response_id );
			
		host_res["signed_response_hash"] = response_signature

	    let service_log;
	    try {
		log.debug("Log service confirmation for Response ID (%s) for request (%s) and host_response (%s) ", response_id, client_req, host_res );
		service_log		= await this.logServiceConfirmation( client_req, host_res, confirmation, agent_id );
		log.info("Service confirmation log hash: %s", service_log );
	    } catch ( err ) {
		const error		= `servicelogger.log_service threw: ${String(err)}`
		log.error("Failed during service confirmation log: %s", error );
		console.error( err );
		return {
		    "error": (new HoloError(error)).toJSON(),
		};
	    }

	    this.removePendingConfirmation( response_id );

	    // - return success
	    log.normal("Response ID (%s) confirmation is complete", response_id );
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
	clients.map( (client:any) => client.client.close() );
	console.log()
	await Promise.all( clients.map( (client:any) => client.client.close() ));
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
		log.normal("Received request to call Conductor using client '%s' with call spec of type '%s'", client, typeof call_spec);
		let interfaceMethod, callAgent;
		try {
			if ( typeof client === "string" )
			client			= this.hcc_clients[ client ];

			// console.log('====================>>>>>>>>>>>>>>>>>>>>> ???????? ', client);

			let ready_state		= client.checkConnection.socket.readyState;
			if ( ready_state !== 1 ) {
			log.silly("Waiting for 'CONNECTED' state because current ready state is %s (%s)", ready_state, READY_STATES[ready_state] );
			await client.opened();
			}

			// Assume the interfaceMethod is using a client that calls an AppWebsocket interface, unless `call_spec` is a function (admin client).
			interfaceMethod			= client.callZome;
			callAgent = 'app'
			if ( call_spec instanceof Function) {
			log.debug("Admin Call spec payload: ( %s )", () => [Object.entries(args).map(([k,v]) => `${k} : ${typeof v}`).join(", ") ]);
			interfaceMethod			= call_spec;
			callAgent 				= 'admin'
			}
			else if ( call_spec.installed_app_id && Object.keys(call_spec).length === 1 ) {
				log.debug("App Info Call spec details for installed_app_id ( %s )", () => [
					call_spec.installed_app_id ]);
				args					= call_spec;
				interfaceMethod			= client.appInfo;
			}
			else {
			// NOTE: call_spec.payload will be null when the zome function accepts no payload
			const payload_log = call_spec.payload ? Object.entries(call_spec.payload).map(([k,v]) => `${k} : ${typeof v}`).join(", ") : call_spec.payload;
			// NOTE: Updated ZomeCall Structure = { cap: null, cell_id: rootState.appInterface.cellId, zome_name, fn_name, provenance: rootState.agentKey, payload }
			log.debug("\nZome Call spec details - called with cap token (%s), provenance (%s), cell_id(%s), and zome fn call: %s->%s( %s )", () => [
				call_spec.cap, call_spec.provenance, call_spec.cell_id, call_spec.zome_name, call_spec.fn_name, payload_log ]);
			args			= call_spec;
			}
		} catch ( err ) {
			console.log("callConductor preamble threw", err );
		throw new HoloError("callConductor preamble threw error: %s", String(err));
		}

		console.log('\nCALL ARGS : ', JSON.stringify(args) );
		
		let resp;
		try {
			// log.silly("Calling Conductor method (%s) over client '%s' with input: %s", interfaceMethod, client.checkConnection.name, JSON.stringify(args) );
			try {
				console.log('\nHERE - Making Conductor call ..........');
				console.log('\n');			
				resp			= await interfaceMethod( args );
				console.log('RESULT >>>>>>>>>>>> ', resp)
			} catch (error) {
				throw new Error(`CONDUCTOR CALL ERROR >>>>> ${JSON.stringify(error)}`);
			}
			
			console.log('callAgent ', callAgent)
			console.log('\n');

			if ( callAgent === "app" ) {
				if ( typeof resp !== 'object' || resp === null)
					log.warn("Expected zome call result to be an object, not '%s'", typeof resp );
				else {
					log.debug("Successful zome call response : ", resp);
					console.log(resp);
				}
			} else {
				log.debug("Successful admin call response : ", resp );
				if (resp) {
					resp.type = "success";
				} else {
					// In the case where admin function doesn't return anything, 
					// **** but doesn't fail (eg: activate_app):
					resp = { type: "success" };
				}
				console.log('RESPONSE : ', resp);
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
				// TODO: RETURN THESE ERROR to Chaperone with { type: "error", message:  }
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
		console.log('\nCONDUCTOR CALL COMPLETE <<<<<<<<<<< ')
		console.log('--------------------------------------------\n');
		return resp;
    }


	// --------------------------------------------------------------------------------------------

    // Service Logger Methods

    addPendingConfirmation ( call_id, client_req, host_res, agent_id ) {
	log.info("Add call ID (%s) to pending confirmations with Agent (%s), Client Request (%s), and Host Restponse (%s)", call_id, agent_id, JSON.stringify( client_req, null, 4 ), JSON.stringify( host_res, null, 4 ) );
	this.pending_confirms[ call_id ] = {
	    agent_id,
		client_req,
		host_res
	};
    }

    getPendingConfirmation ( call_id ) {
	log.info("Get response (%s) from pending confirmations", call_id );
	return this.pending_confirms[ call_id ];
    }

    removePendingConfirmation ( call_id ) {
	log.info("Remove response (%s) from pending confirmations", call_id );
	delete this.pending_confirms[ call_id ];
    }

    async logServiceRequest ( agent_id, payload, signature ) {
	log.normal("Processing service logger request (%s)", signature );

	console.log('LOG ARGS : ', agent_id, payload);

	const call_spec			= payload.call_spec;
	const args_hash			= digest( call_spec["args"] );

	log.debug("Using argument digest: %s", args_hash );
	const request_payload			= {
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

	let request = {
		agent_id,
        request: request_payload,
        request_signature: signature
	}

	console.log('FINISHED REQUEST: ', request);

	//   log.silly("Set service request from Agent (%s) with signature (%s)\n%s", agent_id, signature, JSON.stringify( request, null, 4 ));
	return request;
    }

    async logServiceResponse ( response, metrics ) {
	const response_hash		= digest( response );
	log.normal("Processing service logger response (%s)", response_hash );

	const resp			=  {
		response_hash,
        host_metrics: metrics.cpu,
        weblog_compat: {
          source_ip: "100:0:0:0",
          status_code: 200
		}
		// NB: `signed_response_hash` is added once logServiceConfirmation is called
	};

	log.silly("Set service response (%s) with metrics: %s", response_hash, metrics );
	return resp;
    }

    async logServiceConfirmation ( client_request, host_response, confirmation, agent_id ) {
		log.normal("Processing service logger confirmation (%s) for client request (%s) with host response", confirmation, client_request, host_response );


		log.info("Retreive Servicelogger cell id using the Installed App Id: '%s'", SERVICELOGGER_INSTALLED_APP_ID);
		const appInfo			= await this.callConductor( "internal", { installed_app_id: SERVICELOGGER_INSTALLED_APP_ID });

		if ( !appInfo ) {
		log.error("Failed during Servicelogger AppInfo lookup: %s", appInfo );
		return (new HoloError("Failed to fetch AppInfo for Servicelogger")).toJSON();
		}

		const servicelogger_cell_id			= appInfo.cell_data[0][0];

		log.silly("Recording service confirmation (%s) with payload: %s", confirmation );
		const resp			= await this.callConductor( "service", {
			"cell_id":	servicelogger_cell_id,
			"zome_name":		"service",
			"fn_name":		"log_activity",
			"payload":		{
				"activity":	{
					"request":	client_request,
					"response": host_response,
					"confirmation":	''
				}
			},
			cap: null,
			provenance: agent_id
		});

		if ( resp ) {
			log.info("Returning success response for confirmation log (%s): typeof '%s, %s'", confirmation, typeof resp, resp );
			return resp;
		}
		else {
			log.fatal("Service confirmation log (%s) returned unknown response format: %s", confirmation, resp );
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
