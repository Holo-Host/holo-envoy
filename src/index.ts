import path from 'path';
import logger from '@whi/stdlog';
import concat_stream from 'concat-stream';
import SerializeJSON from 'json-stable-stringify';
import { Codec } from '@holo-host/cryptolib';
import { Package } from '@holo-host/data-translator';
import { HcAdminWebSocket, HcAppWebSocket } from "./websocket-wrappers/holochain";
import { Server as WebSocketServer } from './wss';
import { init as shimInit } from './shim.js';
import Websocket from 'ws';
import { v4 as uuid } from 'uuid';
import * as crypto from 'crypto';
import { getUsagePerDna } from './utils';
const { inspect } = require('util')

const msgpack = require('@msgpack/msgpack');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const log = logger(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const hash = (payload) => {
  const serialized_args = typeof payload === "string" ? payload : SerializeJSON(payload);
  const args_digest = Buffer.from(serialized_args, 'utf8');
  return Codec.Digest.encode(crypto.createHash('sha256').update(args_digest).digest());
}

// Not ever used for anonymous installed_app_ids, which are just the hha_hash
const getInstalledAppId = (hha_hash, agent_id) => {
  return `${hha_hash}:${agent_id}:###zero###`
}

const WS_SERVER_PORT = 4656; // holo
const SHIM_DIR = (process.env.NODE_ENV === "test") ? path.resolve(__dirname, '..', 'tests', 'tmp', 'shim') : path.resolve(__dirname, '/var/lib/holochain-rsm/lair-shim');
const LAIR_SOCKET = (process.env.NODE_ENV === "test") ? path.resolve(__dirname, '..', 'tests', 'tmp', 'keystore', 'socket') : path.resolve(__dirname, '/var/lib/holochain-rsm/lair-keystore/socket');
const RPC_CLIENT_OPTS = {
  "reconnect_interval": 1000,
  "max_reconnects": 300,
};
const CONDUCTOR_TIMEOUT = RPC_CLIENT_OPTS.reconnect_interval * RPC_CLIENT_OPTS.max_reconnects;
const NAMESPACE = "/hosting/";
const READY_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
const WORMHOLE_TIMEOUT = 20_000;
const CALL_CONDUCTOR_TIMEOUT = WORMHOLE_TIMEOUT + 10_000
const STORAGE_POLLING_INTERVAL = 24 * 60 * 60 * 1000 // 1 day

interface CallSpec {
  hha_hash: string;
  dna_alias: string;
  cell_id?: string;
  zome?: string;
  function?: string;
  args?: any;
}

interface AppDna {
  role_id?: string;
	path: string;
	src_path: string;
}

interface HostedAppConfig {
  servicelogger_id: string;
	dnas: [AppDna];
	usingURL: boolean
}

interface EnvoyConfig {
  mode: number;
  port?: number;
  NS?: string;
  hosted_app?: HostedAppConfig;
}


class CustomError extends Error {
  constructor(message) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(message);

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    this.name = this.constructor.name;

    // Fix for Typescript
    //   - https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, this.constructor.prototype);
  }

  toJSON() {
    return {
      "name": this.name,
      "message": this.message,
    };
  }
}

class HoloError extends CustomError {}
class UserError extends CustomError {}

async function promiseMap (array, fn) {
  const resolvedArray = await array;
  const promiseArray = resolvedArray.map(fn);
  const resolved = await Promise.all(promiseArray);
  return resolved;
}

class Envoy {
  ws_server: WebSocketServer;
  shim: { stop: () => Promise<void> };
  opts: EnvoyConfig;
  conductor_opts: any;
  connected: Promise<Array<void>>;

  payload_counter: number = 0;
  pending_confirms: object = {};
  pending_signatures: object = {};
  anonymous_agents: Record<string, string> = {};
  agent_connections: Record<string, Array<Websocket>> = {};
  agent_wormhole_num_timeouts: Record<string, number> = {};

  hcc_clients: { app?: HcAppWebSocket, admin?: HcAdminWebSocket } = {};

  anonymous_app_by_dna: Record<string, { hha_hash: string, anonymous_agent_ids: string[] }> = {};

  slUpdateQueue: any[] = [];

  awakenSlQueueConsumer: (() => void) | null = null

  app_is_activating: Record<string, boolean> = {};

  static PRODUCT_MODE: number = 0;
  static DEVELOP_MODE: number = 1;

  constructor(opts: EnvoyConfig) {
    log.silly("Initializing Envoy with input: %s", opts);
    const environmentMode = opts.mode || Envoy.PRODUCT_MODE;
    this.opts = Object.assign({}, {
      "port": WS_SERVER_PORT,
      "NS": NAMESPACE,
      "mode": environmentMode,
    }, opts);

    log.normal("Initializing with port (%s) and namespace (%s)", this.opts.port, this.opts.NS);

    this.conductor_opts = {
      "interfaces": {
        "admin_port": 4444,
        "app_port": 42233,
      },
    };

    this.connected = this.connections();
    this.connected.then(() => log.normal("All Conductor clients are in a 'CONNECTED' state"));
    this.startWebsocketServer();
    this.startWormhole();
    this.startSlUpdateQueue()
    this.startStoragePolling();
  }

  async startWormhole() {
    this.shim = await shimInit(LAIR_SOCKET, SHIM_DIR, this.wormhole.bind(this));
  }

  async connections() {
    const ifaces = this.conductor_opts.interfaces;
    this.hcc_clients.admin = new HcAdminWebSocket(`ws://localhost:${ifaces.admin_port}`);
    this.hcc_clients.app = new HcAppWebSocket(`ws://localhost:${ifaces.app_port}`, this.signalHandler.bind(this));

    const clients = Object.entries(this.hcc_clients);
    return Promise.all(
      clients.map(async (pair) => {
        const [name, client] = pair;
        await client.opened();
        log.debug("Conductor client '%s' is 'CONNECTED': readyState = %s", name, client.client.socket.readyState);
      })
    );
  }

  // --------------------------------------------------------------------------------------------

  // ENVOY WEBSOCKET SERVER

  async startWebsocketServer() {
    this.ws_server = new WebSocketServer({
      "port": this.opts.port,
      "host": "0.0.0.0", // "localhost",
    });

    const heartbeat = ws => {
      ws.isAlive = true
    }

    const ping = socket => {
      console.log('Pinging to keep socket alive.  Socket readystate : ', socket.readyState)
    }

    this.ws_server.on("connection", async (socket, request) => {
      socket.isAlive = true
      socket.on("pong", () => { heartbeat(socket) })

      // path should contain the HHA ID and Agent ID so we can do some checks and alert the
      // client-side if something is not right.
      log.silly("Incoming connection from %s", request.url);
      const url = new URL(request.url, "http://localhost");

      const heartbeatInterval = setInterval(() => {
        if (socket.isAlive === false) {
          log.info("About to close websocket because socket is no longer alive")
            return socket.close()
        }

        socket.isAlive = false
        socket.ping(() => { ping(socket) })
      }, 30000)


      socket.on("message", (data) => {
        try {
          log.silly("Incoming websocket message: %s", data);
        } catch (err) {
          console.error(err);
        }
      });

      const anonymous = url.searchParams.get('anonymous') === "true" ? true : false;
      const agent_id = url.searchParams.get('agent_id');
      const hha_hash = url.searchParams.get('hha_hash');
      log.normal("%s (%s) connection for HHA ID: %s", anonymous ? "Anonymous" : "Agent", agent_id, hha_hash);

      // Signal is a message initiated in conductor which is sent to UI. To be able to route signals
      // to appropriate agents UIs we need to be able to identify connection based on agent_id and hha_hash.

      // Create event with unique id so that chaperone can subscribe to it.
      // On login connection is re-established with new agent.
      // Don't panic if event already created (might happen on reconnecting)
      const event_id = this.createEventId(anonymous ? 'anonymous' : agent_id, hha_hash);
      log.debug(`Creating signal event ${event_id}`);
      try {
        this.ws_server.event(event_id, this.opts.NS);
      } catch(e) {
        log.debug(`Event ${event_id} already created`);
      }

      // make sure dna2hha entry exists for given hha
      this.recordHha(hha_hash);

      if (anonymous) {
        log.debug(`Adding Agent ${agent_id} to anonymous list with HHA ID ${hha_hash}`);
        this.anonymous_agents[agent_id] = hha_hash;
      } else {
        if (this.agent_connections[agent_id] === undefined) {
          this.agent_connections[agent_id] = [];
        }
        this.agent_connections[agent_id].push(socket);
      }

      socket.on("close", async () => {
        log.warn("Socket is closing for Agent (%s) using HHA ID %s", agent_id, hha_hash);

        // clear ping/pong interval for keepalive check
        clearInterval(heartbeatInterval)

        if (anonymous) {
          log.debug("Remove anonymous Agent (%s) from anonymous list", agent_id);
          delete this.anonymous_agents[agent_id];
        } else {
          const idx = this.agent_connections[agent_id].indexOf(socket);
          delete this.agent_connections[agent_id][idx];
        }
      });
    });

    this.ws_server.register("holo/wormhole/event", async ([agent_id]) => {
      log.normal("Initializing wormhole setup for Agent (%s)", agent_id);
      const event = `${agent_id}/wormhole/request`;

      try {
        log.debug("Registering RPC WebSocket event (%s) in namespace: %s", event, this.opts.NS);
        this.ws_server.event(event, this.opts.NS);
      } catch (e) {
        if (e.message.includes('Already registered event'))
          log.warn("RPC WebSocket event '%s' is already registered for Agent (%s)", event, agent_id);
        else {
          log.error("Failed during RPC WebSocket event registration: %s", String(e));
          log.error(e);
        }
      }

      return event;
    }, this.opts.NS);

    this.ws_server.register("holo/wormhole/response", async ([payload_id, signature]) => {
      log.normal("Received signing response #%s with signature: %s", payload_id, signature);

      // - match payload ID to payload
      const [payload, f, r, toid] = this.pending_signatures[payload_id];

      // - respond to HTTP request
      f(signature);

      // clear fallback timeout response
      clearTimeout(toid);

      // - return success
      return true;
    }, this.opts.NS);


    // ------------------------------------------------------------------------

	// EXPOSED ENVOY EVENTS
    // Envoy - New Hosted Agent Sign-up Sequence
    this.ws_server.register("holo/agent/signup", async ([hha_hash, agent_id, membrane_proof]) => {
      log.normal("Received sign-up request from Agent (%s) for HHA ID: %s", agent_id, hha_hash);

      const anonymous_instance_app_id = hha_hash;
      const hosted_agent_instance_app_id = getInstalledAppId(hha_hash, agent_id);

      log.info("Retrieve the hosted app cell_data using the anonymous installed_app_id: '%s'", anonymous_instance_app_id);
      const appInfo = await this.callConductor("app", { installed_app_id: anonymous_instance_app_id });

      if (!appInfo) {
        log.error("Failed during hosted app's AppInfo call: %s", appInfo)
        return Package.createFromError("HoloError", (new HoloError("Failed to create a new hosted agent")).toJSON())
      }

      log.silly('NUMBER OF DNAs in the hosted happ: ', appInfo.cell_data.length)
      log.silly('AppInfo on sign-up: ', appInfo)

      log.silly("Hosted App Cell Data: %s", appInfo.cell_data);
      log.info("Found %s DNA(s) for the app bundle with HHA ID: %s", appInfo.cell_data.length, hha_hash);

      const buffer_agent_id = Codec.AgentId.decodeToHoloHash(agent_id);
      log.info("Encoded Agent ID (%s) into buffer form: %s", agent_id, buffer_agent_id);

      try {
        let adminResponse;
        // - Install App - This admin function creates cells for each dna with associated role_id, under the hood.
        try {
          log.info("Installing App with HHA ID (%s) as Installed App ID (%s) ", hha_hash, hosted_agent_instance_app_id);
          let dnas;

          if (this.opts.hosted_app && this.opts.hosted_app!.dnas && this.opts.mode === Envoy.DEVELOP_MODE) {
            dnas = this.opts.hosted_app.dnas;
					} else {
            dnas = appInfo.cell_data.map(({cell_id, role_id }) => ({ role_id, hash: cell_id[0], membrane_proof }));
					}

          if (membrane_proof) {
            log.normal("App includes membrane_proof: %s", membrane_proof);
            for (const dnaIdx in dnas) {
              dnas[dnaIdx].membrane_proof = Buffer.from(membrane_proof, 'base64')
            }
          }

          log.debug('dnas : %j', dnas);

          adminResponse = await this.callConductor("admin", 'installApp', {
            installed_app_id: hosted_agent_instance_app_id,
            agent_key: buffer_agent_id,
            dnas
          });

          if (adminResponse.type !== "success") {
            log.error("Conductor 'installApp' returned non-success response: %s", adminResponse);
            throw (new HoloError(`Failed to complete 'installApp' for installed_app_id'${hosted_agent_instance_app_id}'.`)).toJSON();
          }
        } catch (err) {
          if (err.message.toLowerCase().includes("duplicate cell")) {
            log.warn("Cell (%s) already exists in Conductor", hosted_agent_instance_app_id);
          } else {
            if (err.toString().includes("GenesisFailure")) {
              if (err.toString().includes("No membrane proof found")) {
                throw new UserError("Missing membrane proof")
              } else if (err.toString().includes("Joining code invalid")) {
                throw new UserError("Invalid joining code")
              }
              const genesisFailureStart = err.toString().indexOf('GenesisFailure("') + 15
              const genesisFailureEnd = err.toString().indexOf('")') + 1
              const genesisFailureMessage = err.toString().substring(genesisFailureStart, genesisFailureEnd)
              throw new UserError(genesisFailureMessage)
            }
            log.error("Failed during 'installApp': %s", String(err));
            throw err;
          }
        }

        await this.signIn(hha_hash, agent_id);
      } catch (err) {
        log.error("Failed during DNA processing for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, String(err));
        let error_pack;
        if  (err instanceof UserError) {
          log.warn("Setting error response to raised UserError: %s", String(err));
          error_pack = Package.createFromError("UserError", err.toJSON());
        } else {
          let holo_error;
          if (err instanceof HoloError) {
            log.warn("Setting error response to raised HoloError: %s", String(err));
            holo_error = err.toJSON();
          } else {
            holo_error = {
              "source": 'HoloError',
              "message": err.message,
            };
          }
          error_pack = Package.createFromError("HoloError", holo_error);
        }
        log.normal('Returning error: ', error_pack);
        return error_pack
      }

      // - return success
      log.normal("Completed sign-up process for Agent (%s) HHA ID (%s)", agent_id, hha_hash);
      return new Package(true, { "type": "success" });
    }, this.opts.NS);

    // Envoy - New Hosted Agent Sign-up Sequence
    this.ws_server.register("holo/agent/signin", async ([hha_hash, agent_id]) => {
      log.normal("Received sign in request from Agent (%s) for HHA ID: %s", agent_id, hha_hash);
      try {
        const signInResult = await this.signIn(hha_hash, agent_id);
        log.normal("Completed sign-in process for Agent (%s) HHA ID (%s)", agent_id, hha_hash);
        if (signInResult === true) {
          return new Package(signInResult, { "type": "success" });
        } else {
          return new Package(false, { "type": "success" });
        }
      } catch (err) {
        if (err.toString().includes("AppNotInstalled")) {
          return Package.createFromError("HoloError", (new HoloError('Failed during Conductor AppInfo call')).toJSON());
        }
        return Package.createFromError("UserError", (new UserError(`Failed to sign-in an existing hosted agent: ${inspect(err)}`)).toJSON());
      }
    }, this.opts.NS);

    // Chaperone AppInfo Call to Envoy Server
    // NOTE: we have decided as a team to charge for app_info calls, but after release and user feedback
    this.ws_server.register("holo/app_info", async ({ installed_app_id }) => {
      let appInfo
      try {
        log.debug("Calling AppInfo function with installed_app_id(%s) :", installed_app_id);
        appInfo = await this.callConductor("app", { installed_app_id });
        if (!appInfo) {
          log.error("Conductor call 'appInfo' returned non-success response: %s", appInfo);
          throw new HoloError(`Failed to call 'appInfo' for installed_app_id'${installed_app_id}'.`);
        }
        log.info("appInfo.status", inspect(appInfo.status))
      } catch (err) {
        log.error("Failed during Conductor AppInfo call: %s", String(err));
        if (err instanceof HoloError) {
          const holoError = err.toJSON();
          return Package.createFromError("HoloError", holoError)
        }
        return Package.createFromError("HoloError", (new HoloError('Failed during Conductor AppInfo call')).toJSON());
      }

      const response_id = uuid();
      log.normal("Completed AppInfo call for installed_app_id (%s) with response_id (%s)...", installed_app_id, response_id);
      return new Package(appInfo, { "type": "success" }, { response_id });
    }, this.opts.NS);

    // Chaperone ZomeCall to Envoy Server
    this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, service_signature }: {
      anonymous: boolean
      agent_id: string
      payload: {
        timestamp: string
        host_id: string
        call_spec: {
          hha_hash: string
          dna_alias: string
          cell_id: string
          zome: string
          function: string
          // Base 64 + MessagePack encoded
          args: string
        }
      }
      service_signature: string
    }) => {
      log.silly("Received request: %s", payload.call_spec);
      // calcuate the cpuUsage prior to zomeCall to create a baseline
      const baselineCpu = process.cpuUsage()

      const call_spec = payload.call_spec;
      const decodedArgs = msgpack.decode(Buffer.from(call_spec.args, 'base64'));
      log.normal("Received zome call request from Agent (%s) with spec: %s::%s->%s",
        agent_id, call_spec.cell_id, call_spec.zome, call_spec.function);
      log.silly("agrs: ( %j )", decodedArgs);

      // - Servicelogger request. If the servicelogger.log_{request/response} fail (eg. due
      // to bad signatures, wrong host_id, or whatever), then the request cannot proceed, and
      // we'll immediately return an error w/o a response_id or result.
      let request;

      log.debug("Log service request (%s) from Agent (%s)", service_signature, agent_id);
      request = await this.logServiceRequest(agent_id, payload, service_signature);

      // ZomeCall to Conductor App Interface
      const zomeCallArgs = {
        cell_id: [Buffer.from(call_spec.cell_id[0]), Buffer.from(call_spec.cell_id[1])],
        zome_name: call_spec.zome,
        fn_name: call_spec.function,
        payload: decodedArgs,
        cap: null, // Note: when null, this call will pass when the agent has an 'Unrestricted' status (this includes all calls to an agent's own chain)
        provenance: anonymous ? Codec.AgentId.decodeToHoloHash(agent_id) : Buffer.from(call_spec.cell_id[1]), // when anonymous, the agent pubkey will not be the cell's agent pubkey
      }

      const prettyZomeCallArgs = {
        ...zomeCallArgs,
        cell_id: [Codec.HoloHash.encode("dna", zomeCallArgs.cell_id[0]), Codec.AgentId.encode(zomeCallArgs.cell_id[1])],
        provenance: Codec.AgentId.encode(zomeCallArgs.provenance),
      }
      let zomeCallResponse, holo_error

      try {
        log.silly("Calling zome function with parameters: %s", prettyZomeCallArgs);
        zomeCallResponse = await this.callConductor("app", zomeCallArgs);
      } catch (err) {
        log.error("Failed during Conductor call: %s", String(err));
        zomeCallResponse = {};

        if (err.message.includes("Failed to get signatures from Client")) {
          let new_message = anonymous === true
            ? "Agent is not signed-in"
            : "We were unable to contact Chaperone for the Agent signing service.  Please check ...";

          log.warn("Setting error response to wormhole error message: %s", new_message);
          holo_error = (new HoloError(new_message)).toJSON();
        } else if (err instanceof HoloError) {
          log.warn("Setting error response to raised HoloError: %s", String(err));
          holo_error = err.toJSON();
        } else {
          log.fatal("Conductor call threw unknown error: %s", String(err));
          log.error(err);
          holo_error = {
            "source": 'HoloError',
            "message": err.message,
          };
        }
      }

      // - return host response
      let response_message;
      if (holo_error) {
        const errorPack = Package.createFromError("HoloError", holo_error);
        log.normal('Returning error: ', errorPack);
        response_message = errorPack;
      }
      else {
				// - Servicelogger response
				let host_response;

        // Note: we're caluclating cpu time usage of the current process (zomecall) in microseconds (not seconds)
        const cpuUsage = process.cpuUsage(baselineCpu)
        const cpu = cpuUsage.user + cpuUsage.system

        const responseEncoded = Buffer.from(msgpack.encode(zomeCallResponse)).toString('base64')

        // Note: we're calculating bandwidth by size of zomeCallResponse in Bytes (not bits)
        const inbound_payload_buffer = Buffer.from(JSON.stringify(payload));
        const outbound_payload_buffer = Buffer.from(JSON.stringify(zomeCallResponse));
        const bandwidth = Buffer.byteLength(outbound_payload_buffer) + Buffer.byteLength(inbound_payload_buffer)

				const host_metrics = {
					cpu,
          bandwidth
				};

        const weblog_compat = {
					source_ip: "100:0:0:0",
					status_code: 200
				}

				log.debug("Form service response for signed request (%s): %s", service_signature, JSON.stringify(request, null, 4));
				host_response = this.logServiceResponse(zomeCallResponse, host_metrics, weblog_compat);
				log.silly("Service response by Host: %s", JSON.stringify(host_response, null, 4));

				// Use response_id to act as waiting ID
				const response_id = uuid();

				log.info("Adding service call ID (%s)... to waiting list for client confirmations for agent (%s)", response_id, agent_id);
				this.addPendingConfirmation(response_id, request, host_response, agent_id);

				log.normal("Returning host reponse (%s) for request (%s) with signature (%s) as response_id (%s)... to chaperone",
          JSON.stringify(host_response, null, 4), JSON.stringify(request, null, 4), JSON.stringify(service_signature), response_id);

        response_message = new Package({ zomeCall_response: responseEncoded }, { "type": "success" }, { response_id, host_response });
      }

      return response_message;
    }, this.opts.NS);

    // Temporary "state dump" logic for checking Holochain network peer consistency
    this.ws_server.register("holo/tmp/state_dump", async ({ installed_app_id, dna_alias }) => {
      let appInfo
      try {
        log.debug("Calling AppInfo function with installed_app_id(%s) :", installed_app_id);
        appInfo = await this.callConductor("app", { installed_app_id });
        if (!appInfo) {
          log.error("Conductor call 'appInfo' returned non-success response: %s", appInfo);
          throw new HoloError(`Failed to call 'appInfo' for installed_app_id'${installed_app_id}'.`);
        }
      } catch (err) {
        log.error("Failed during Conductor AppInfo call: %s", String(err));
        return Package.createFromError("HoloError", (new HoloError('Failed during Conductor AppInfo call')).toJSON());
      }

      let result
      try {
        const cell_data: Array<{cell_id: Buffer, role_id: Buffer}> = appInfo.cell_data;
        const {cell_id} = cell_data.find(({cell_id, role_id}) => dna_alias === role_id);
        result = await this.callConductor("admin", "dumpState", { cell_id });
      } catch (err) {
        log.error("Failed during Conductor StateDump call: %s", String(err));
        return Package.createFromError("HoloError", (new HoloError('Failed during Conductor StateDump call')).toJSON());
      }
      return new Package(result, { "type": "success" });
    }, this.opts.NS);

    // Chaperone Call to Envoy Server to confirm service
    this.ws_server.register("holo/service/confirm", async ([response_id, response_signature, confirmation]) => {
      log.normal("Received confirmation request for call response (%s)...", response_id);
      if (process.env.SKIP_LOG_ACTIVITY) {
        log.silly("Skipping confirmation request")
        return new Package(true, { "type": "success" }, { response_id });
      }
      if (typeof response_id !== "string") {
        log.error("Invalid type '%s' for response ID, should be of type 'string'", typeof response_id);
        return false;
      }

      // - Servicelogger confirmation
      const { agent_id,
        client_req, host_res } = this.getPendingConfirmation(response_id);
      host_res["signed_response_hash"] = response_signature;

      let service_log;
      try {
        log.debug("Log service confirmation for Response ID (%s)... for agent_id (%s)", response_id, agent_id);
        service_log = await this.logServiceConfirmation(client_req, host_res, confirmation);
        log.info("Service confirmation log hash: %s", service_log);
      } catch (err) {
        const error = `servicelogger.log_service threw: ${String(err)}`
        log.error("Failed during service confirmation log: %s", error);
        log.error(err);

        this.removePendingConfirmation(response_id);

        const errorPack = Package.createFromError("HoloError", err);
        log.normal('Returning error: ', errorPack);

        return errorPack;
      }

      this.removePendingConfirmation(response_id);

      log.normal("Confirmation for call with response ID (%s)... is complete", response_id);
      // - return success
      // updated to match hhdt success message format
      return new Package(true, { "type": "success" }, { response_id });
    }, this.opts.NS);
  }

  // Activate App - Tell Holochain to begin gossiping and be ready for zome calls on this app.
  async activateApp (installed_app_id) {
    try {
      log.info("Activating Installed App (%s)", installed_app_id);
      const adminResponse = await this.callConductor("admin", "activateApp", { installed_app_id });

      if (adminResponse.type !== "success") {
        log.error("Conductor 'activateApp' returned non-success response: %s", adminResponse);
        throw new HoloError(`Failed to complete 'activateApp' for installed_app_id'${installed_app_id}'.`).toJSON()
      } else {
        log.normal("Completed activateApp process for installed_app_id (%s)", installed_app_id);
        return
      }
    } catch (err) {
      if (err.message.includes("AppNotInstalled")) {
        // This error is returned in two cases:
        // a) TODO: The app is not installed -- Return an error to the user saying that they may need to sign up first.
        // b) The app is already activated -- Our job is done.

        // Check for the second case using appInfo
        try {
          const appInfo = await this.callConductor("app", { installed_app_id: installed_app_id });
          // Check that the appInfo result was not null (would indicate app not installed)
          if (appInfo.installed_app_id !== undefined && appInfo.status.running) {
            log.normal("Completed activateApp process for installed_app_id (%s)", installed_app_id);
            return
          } else if (appInfo.status!.disabled?.reason!.error) {
            log.error("'appInfo' revealed app as permanently disabled because: %s", JSON.stringify(appInfo.status.disabled.reason.error));
            throw new HoloError(`Failed to complete activation for installed_app_id'${installed_app_id}'. App permanently disabled due to error: ${appInfo.status.disabled.reason.error}`).toJSON()
          }
          throw new HoloError(`Failed to complete activation for installed_app_id'${installed_app_id}'.`).toJSON()
        } catch (appInfoErr) {
          log.error("Failed during 'appInfo': %s", String(appInfoErr));
          throw new HoloError(`Failed to complete 'appInfo' for installed_app_id'${installed_app_id}'.`).toJSON()
        }
      }
      log.error("Failed during 'activateApp': %s", String(err));
      throw err
    }
  }

  async signIn(hha_hash, agent_id): Promise<boolean> {
    if (agent_id in this.anonymous_agents) {
      // Nothing to do. Anonymous cell is always active
      return true;
    }

    const installed_app_id = getInstalledAppId(hha_hash, agent_id);

    log.normal('Is app already activating: ', this.app_is_activating[installed_app_id] ?? false);

    while (this.app_is_activating[installed_app_id]) {
      await delay(5000)
    }

    this.app_is_activating[installed_app_id] = true

    try {
      await this.activateApp(installed_app_id)
    } finally {
      delete this.app_is_activating[installed_app_id]
    }

    log.normal("Completed sign-in process for installed_app_id (%s)", installed_app_id);
    return true
  }

  async signOut(agent_id: string): Promise<void> {
    const connections = this.agent_connections[agent_id];
    delete this.agent_connections[agent_id];
    connections.forEach(connection => connection.close());
    delete this.agent_wormhole_num_timeouts[agent_id];
  }

  startStoragePolling () {
    this.updateStorageUsage()
    setInterval(this.updateStorageUsage.bind(this), STORAGE_POLLING_INTERVAL)
  }

  updateStorageUsage () {
    const dnaHashes = this.getHostedDnaHashes()

    let usagePerDna
    try {
      usagePerDna = getUsagePerDna(dnaHashes)
    } catch (e) {
      log.error('failed to get disk usage for dnas:', e.toString())
      return
    }

    Object.keys(usagePerDna).forEach(async dnaHash => {
      try {
        const { diskUsage, sourceChainUsagePerAgent } = usagePerDna[dnaHash]
        const sourceChains = Object.keys(sourceChainUsagePerAgent).map(agentKey =>
          [Codec.AgentId.decodeToHoloHash(agentKey), sourceChainUsagePerAgent[agentKey].length])

        const payload = {
          source_chains: sourceChains,
          integrated_entries: [],
          total_disk_usage: diskUsage
        }

        const hhaHash = this.anonymous_app_by_dna[dnaHash].hha_hash
        if (hhaHash === undefined) {
          log.normal(`Couldn't log disk usage, no hhaHash (so no service logger) for dna ${dnaHash}`)
          return
        }

        log.normal('Logging disk and sourcechain usage for dna', dnaHash)
        log.normal('Usage payload', payload)

        const cellId = await this.getServiceLoggerCellId(hhaHash)

        await this.callSlUpdate({
          cell_id: cellId,
          zome_name: "service",
          fn_name: "log_disk_usage",
          payload,
          cap: null,
          provenance: cellId[1]
        })
      } catch (e) {
        log.error(`error updating disk usage for ${dnaHash}`, e.toString())
        return
      }
    })
  }

  // --------------------------------------------------------------------------------------------
  // WORMHOLE Signing function
  // Note: we need to figure out a better way to manage this timeout.
  // One idea is to make it based on the payload_counter and every 10 requests we increase the timeout by 10sec
  wormhole(agent: Buffer, payload: any, timeout = WORMHOLE_TIMEOUT) {
    log.normal("Wormhole Signing Requested...");
    const payload_id = this.payload_counter++;
    const agent_id = Codec.AgentId.encode(agent);
    log.normal("Opening a request (#%s) for Agent (%s) signature of payload: typeof '%s'", payload_id, agent_id, typeof payload);
    const event = `${agent_id}/wormhole/request`;
    log.silly(`Agent id: ${agent_id}`);
    log.silly("Payload to be signed: %s", msgpack.decode(payload));
    if (this.ws_server.eventList(this.opts.NS).includes(event) === false) {
      log.warn("Trying to get signature from unknown Agent (%s)", agent_id);
      if (Object.keys(this.anonymous_agents).includes(agent_id))
        throw new Error(`Agent ${agent_id} cannot sign requests because they are anonymous`);
      else {
        log.normal(`Agent ${agent_id} is not registered.  It must be a host call`);
        // Returning null will let the shim redirect to the local lair instance
        return null
      }
    }
    return new Promise((f, r) => {
      let toid = setTimeout(() => {
        log.error("Failed during signing request #%s with timeout (%sms)", payload_id, timeout);
        // If the same agent times out 3 times, sign them out.
        // If the same agent times out more than 3 times, then we are already in the process of signing them out.
        if (this.agent_wormhole_num_timeouts[agent_id] === undefined) {
          this.agent_wormhole_num_timeouts[agent_id] = 0;
        }
        log.debug('adding an agent wormhole num timeout')
        this.agent_wormhole_num_timeouts[agent_id] += 1;
        if (this.agent_wormhole_num_timeouts[agent_id] === 3) {
          this.signOut(agent_id).catch(err => {
            log.error("Failed to sign out Agent (%s) after they disconnected from wormhole: %s", agent_id, String(err));
          });
        }
        r("Failed to get signature from Chaperone")
      }, timeout);

      log.info("Adding signature request #%s to pending signatures", payload_id);
      this.pending_signatures[payload_id] = [payload, f, r, toid];

      this.ws_server.emit(event, [payload_id, payload]);
      log.normal("Sent signing request #%s to Agent (%s)", payload_id, agent_id);
    });
  }

  // --------------------------------------------------------------------------------------------
  // RPC Connection Handling
  async close() {
    log.normal("Initiating shutdown; closing Conductor clients, RPC WebSocket server, then HTTP server");

    const clients = Object.values(this.hcc_clients);
    await Promise.all(clients.map((client: HcAdminWebSocket | HcAppWebSocket) => client.close()));
    log.info("All Conductor clients are closed");

    await this.ws_server.close();
    log.info("RPC WebSocket server is closed");

    await this.shim.stop();
    log.info("Wormhole server is closed");
  }

  // --------------------------------------------------------------------------------------------

  // Conductor Call Handling

  validHoloHashPrefix(holoHashStrPrefix) {
    switch (holoHashStrPrefix) {
      case "uhCAk": // agent
      case "uhCkk": // header
      case "uhCEk": // entry
      case "uhC0k": // dna
        return true;
      default:
        log.warn("Received unsupported HoloHash Prefix : ", holoHashStrPrefix);
        return false
    }
  }

  verifyHoloHash(resp) {
    if (typeof resp !== 'string') return false;
    const isHoloHash = (Buffer.byteLength(Buffer.from(resp.slice(1), "base64")) === 39) && this.validHoloHashPrefix(resp.substring(0, 5));
    return isHoloHash;
  }

  async callConductor(client, call_spec, args: any = null, timeout = CALL_CONDUCTOR_TIMEOUT) {
    log.normal("Received request to call Conductor using client '%s' with call spec of type '%s'", client, typeof call_spec);
    let interfaceMethod, methodName, callAgent;
    let pleaseCloseClient = false;
    if (typeof client === "string") {
      if (client === "admin") {
        client = this.hcc_clients[client];
      } else {
        // Reason: we are creating a new connection is to avoid the issues in https://github.com/holochain/holochain-conductor-api/issues/55
        // Not we also do not need to add a signal-handler to this because it would cause users to get double signals since we still have `hcc_clients.app` that receives signals
        client = new HcAppWebSocket(`ws://localhost:${this.conductor_opts.interfaces.app_port}`, (_)=>{/* do not do anything */});;
        pleaseCloseClient = true;
      }
    }

    await Promise.race([client.opened(), delay(1000)]);
    let ready_state = client.client.socket.readyState;
    if (ready_state !== 1) {
      throw new HoloError("Conductor disconnected");
    }
    try {
      // Assume the interfaceMethod is using a client that calls an AppWebsocket interface, unless `call_spec` is a string (admin client).
      interfaceMethod = client.callZome;
      methodName = 'callZome'
      callAgent = 'app'
      if (typeof call_spec === 'string') {
        log.debug("Admin Call spec payload: ( %s )", () => [Object.entries(args).map(([k, v]) => `${k} : ${typeof v}`).join(", ")]);
        interfaceMethod = client[call_spec];
        methodName = call_spec;
        callAgent = 'admin';
      }
      else if (call_spec.installed_app_id && Object.keys(call_spec).length === 1) {
        log.debug("App Info Call spec details for installed_app_id ( %s )", () => [
          call_spec.installed_app_id]);
        args = call_spec;
        interfaceMethod = client.appInfo;
        methodName = 'appInfo'
      }
      else {
        // NOTE: call_spec.payload should be null when the zome function accepts no payload
        const payload_log = (typeof call_spec.args === 'object') ? Object.entries(call_spec.payload).map(([k, v]) => `${k} : ${typeof v}`).join(", ") : call_spec.payload;
        log.debug("Zome Call spec details - called with cap token (%s), provenance (%s), cell_id(%s), and zome fn call: %s->%s( %s )", () => [
          call_spec.cap, call_spec.provenance, call_spec.cell_id, call_spec.zome_name, call_spec.fn_name, payload_log]);

        args = call_spec;
      }
    } catch (err) {
      if (pleaseCloseClient) {
        await client.close()
      }
      log.debug("CallConductor preamble threw error: ", err);
      throw new HoloError(`callConductor preamble threw error: ${String(err)}}`, );
    }

    let resp;
    try {
      log.silly("Calling Conductor method (%s) over client '%s' with input %s: ", methodName, callAgent, JSON.stringify(args));
      try {
        resp = await interfaceMethod(args, timeout);
      } catch (error) {
        console.log("CONDUCTOR CALL ERROR: ");
        console.log(error);

        if (inspect(error).includes("GenesisFailure")) {
          throw new HoloError(inspect(error))
        } else {
          throw new Error(`CONDUCTOR CALL ERROR: ${inspect(error)}`);
        }
      }

      if (callAgent === "app") {
        if (typeof resp !== 'object' || resp === null) {
          const validHoloHash = this.verifyHoloHash(resp);
          // If AppInterface call response is not an object, it should be a holohash of type header, entry, agent, or dna
          if (validHoloHash) {
            log.debug("Successful app interface response: %s ", JSON.stringify(resp));
          } else {
            log.warn("Expected app interface (eg: ZomeCall, AppInfo) call result to be an object, not '%s', resp: ", typeof resp, JSON.stringify(resp));
          }
        }
        else {
          log.debug("Successful app interface response: %s ", JSON.stringify(resp));
        }
      } else {
        if (resp) {
          resp.type = "success";
        } else {
          // In the case where admin function doesn't return anything (eg: activate_app),
          // *** but doesn't fail, need to form response obj:
          resp = { type: "success" };
        }
        log.debug("Successful admin interface response: %s ", JSON.stringify(resp));
      }
    } catch (err) {
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
      if (pleaseCloseClient) await client.close()
      if (err.code === -32000) {
        if (err.data.includes("response from service is not success")) {
          // differentiate between a signing error bc could not reach service and a FAILED signing service
          log.error("Failed during Conductor call because of a signing request error: %s", err.data);
          throw new HoloError("Failed to get signatures from Client");
        }
        else {
          log.fatal("Failed during Conductor call with RPC Internal Error: %s -> %s", err.message, err.data);
          throw new HoloError(`Unknown -32000 Error: ${JSON.stringify(err)}`);
        }
      } else if (err instanceof Error) {
        log.error("Failed during Conductor call with error: %s", String(err));
        if (err.name === 'HoloError') throw err
        throw new HoloError(String(err));
      } else {
        log.fatal("Failed during Conductor call with unknown error: %s", err);
        throw new HoloError(`Unknown RPC Error: ${JSON.stringify(err)}`);
      }
    }
    if (pleaseCloseClient) await client.close()
    log.normal("Conductor call returned successful '%s' response: %s ", typeof resp, resp);
    return resp;
  }

  // --------------------------------------------------------------------------------------------

  // Service Logger Methods

  async callSlUpdate (args) {
    return await new Promise((resolve, reject) => {
      this.slUpdateQueue.push([
        args,
        resolve,
        reject
      ])
      if (this.awakenSlQueueConsumer) {
        this.awakenSlQueueConsumer()
      }
    })
  }

  async startSlUpdateQueue () {
    while (true) {
      let slUpdate
      slUpdate = this.slUpdateQueue.shift()

      while (slUpdate) {
        const [args, resolve, reject] = slUpdate
        try {
          const result = await this.callConductor("app", args);
          resolve(result)
        } catch (e) {
          reject(e)
        }

        slUpdate = this.slUpdateQueue.shift()
      }

      await new Promise<void>(resolve => this.awakenSlQueueConsumer = resolve)
    }
  }

  addPendingConfirmation(response_id, client_req, host_res, agent_id) {
    if (process.env.SKIP_LOG_ACTIVITY) {
      log.silly("Skipping addPendingConfirmation")
      return
    }
    log.info("Add response ID (%s)... from pending confirmations", response_id);
    log.silly("Add response ID (%s)... to pending confirmations for Agent (%s) with client request (%s) and host response (%s)", response_id, agent_id, client_req, host_res);
    this.pending_confirms[response_id] = {
      agent_id,
      client_req,
      host_res
    };
  }

  getPendingConfirmation(response_id) {
    log.info("Get response ID (%s)... from pending confirmations", response_id);
    return this.pending_confirms[response_id];
  }

  removePendingConfirmation(response_id) {
    log.info("Remove response ID (%s)... from pending confirmations", response_id);
    delete this.pending_confirms[response_id];
  }

  async logServiceRequest(agent_id, payload, signature) {
    log.normal("Processing service logger request (%s)", signature);

    const call_spec = payload.call_spec;
    const args_hash = hash(call_spec["args"]);

    log.debug("Using argument digest: %s", args_hash);
    const request_payload = {
      "timestamp": payload.timestamp,
      // NB: Servicelogger expects the holo host agent ID as a string (wrapped agent hash), instead of the agent holohash buf.
      "host_id": payload.host_id,
      "call_spec": {
        "hha_hash": call_spec["hha_hash"],
        "dna_alias": call_spec["dna_alias"],
        "zome": call_spec["zome"],
        "function": call_spec["function"],
        "args_hash": args_hash,
      },
    };

    let request = {
      agent_id: agent_id,
      request: request_payload,
      request_signature: signature
    }
    log.silly("Set service request from Agent (%s) with signature (%s)\n%s", agent_id, signature, JSON.stringify(request, null, 4));
    return request;
  }

  logServiceResponse(response, host_metrics, weblog_compat) {
    const response_hash = hash(response);
    log.normal("Processing service logger response (%s)", response_hash);

    // NB: The signed_response_hash is added to the response obj when `logServiceConfirmation` is called
    const resp = {
      response_hash,
      host_metrics,
      weblog_compat,
    };

    log.silly("Set service response (%s) with metrics (%s) and weblog_compat (%s)", response_hash, host_metrics, weblog_compat);
    return resp;
  }

  async getServiceLoggerCellId(hha_hash) {
    let servicelogger_installed_app_id
    if (this.opts.hosted_app && this.opts.hosted_app!.servicelogger_id && this.opts.mode === Envoy.DEVELOP_MODE) {
      servicelogger_installed_app_id = this.opts.hosted_app.servicelogger_id;
    } else {
      // NB: There will be a new servicelogger app for each hosted happ (should happen at the time of self-hosted install - prompted in host console.)
      servicelogger_installed_app_id = `${hha_hash}::servicelogger`;
    }

    log.info("Retrieve Servicelogger cell id using the Installed App Id: '%s'", servicelogger_installed_app_id);
    const appInfo = await this.callConductor("app", { installed_app_id: servicelogger_installed_app_id });

    if (!appInfo) {
      log.error("Failed during Servicelogger AppInfo lookup: %s", appInfo);
      throw new HoloError("Failed to fetch AppInfo for Servicelogger")
    }

    log.debug("Servicelogger app_info: '%s'", appInfo);
    // We are assuming that servicelogger is a happ and the first cell is the servicelogger DNA
    return appInfo.cell_data[0].cell_id;
  }

  async logServiceConfirmation(client_request, host_response, confirmation) {
    log.info("Processing service logger confirmation");
    log.silly("Processing service logger confirmation (%s) for client request (%s) with host response", confirmation, client_request, host_response);

    const hha_hash = client_request.request.call_spec.hha_hash;

    // This code should be replaceable with this.getServiceLoggerCellId, but for some reason it breaks.
    let servicelogger_installed_app_id

    if (this.opts.hosted_app && this.opts.hosted_app!.servicelogger_id && this.opts.mode === Envoy.DEVELOP_MODE) {
      servicelogger_installed_app_id = this.opts.hosted_app.servicelogger_id;
    } else {
      // NB: There will be a new servicelogger app for each hosted happ (should happen at the time of self-hosted install - prompted in host console.)
      servicelogger_installed_app_id = `${hha_hash}::servicelogger`;
    }

    log.info("Retrieve Servicelogger cell id using the Installed App Id: '%s'", servicelogger_installed_app_id);
    const appInfo = await this.callConductor("app", { installed_app_id: servicelogger_installed_app_id });

    if (!appInfo) {
      log.error("Failed during Servicelogger AppInfo lookup: %s", appInfo);
      return (new HoloError("Failed to fetch AppInfo for Servicelogger")).toJSON();
    }

    log.debug("Servicelogger app_info: '%s'", appInfo);
    // We are assuming that servicelogger is a happ and the first cell is the servicelogger DAN
    const servicelogger_cell_id = appInfo.cell_data[0].cell_id;
    const buffer_host_agent_servicelogger_id = servicelogger_cell_id[1];

    client_request["request_signature"] = Codec.Signature.decode(client_request["request_signature"])
    host_response["signed_response_hash"] = Codec.Signature.decode(host_response["signed_response_hash"])
    confirmation["confirmation_signature"] = Codec.Signature.decode(confirmation["confirmation_signature"])

    const payload = {
      "request": client_request,
      "response": host_response,
      "confirmation": confirmation,
    }

    log.silly("Recording service confirmation with payload: activity: { request: %s, response: %s, confimation: %s }", client_request, host_response, confirmation);
    let resp

    let retryCall = true
    while (retryCall) {
      retryCall = false
      try {
        resp = await this.callSlUpdate({
          "cell_id": servicelogger_cell_id,
          "zome_name": "service",
          "fn_name": "log_activity",
          payload,
          cap: null,
          provenance: buffer_host_agent_servicelogger_id,
        })
      } catch (e) {
        if (String(e).includes("source chain head has moved")) {
          retryCall = true
        } else {
          throw e
        }
      }
    }

    if (resp) {
      log.silly('\nFinished Servicelogger confirmation: ', resp);
      log.silly("Returning success response for confirmation log (%s): typeof '%s, %s'", confirmation, typeof resp, resp);
      log.info("Returning success response for confirmation log");
      return resp;
    }
    else {
      log.fatal("Service confirmation log (%s) returned unknown response format: %s", confirmation, resp);
      let content = typeof resp === "string" ? resp : `keys? ${Object.keys(resp)}`;
      throw new Error(`Unknown 'service->log_service' response format: typeof '${typeof resp}' (${content})`);
    }
  }

  // --------------------------------------------------------------------------------------------

  // Functions handling translation of dna_hash to hha_hash

  async recordHha(hha_hash) {
    // dna2hha is add-only
    if (!this.hhaExists(hha_hash)) {
      log.info("Retrieve the hosted app cell_data using the anonymous installed_app_id: '%s'", hha_hash);

      const appInfo = await this.callConductor("app", { installed_app_id: hha_hash });

      if (!appInfo) {
        throw new Error(`No app found with installed_app_id: ${hha_hash}`);
      }

      // TODO but leave it for now: I am operating under the assumption that each dna_hash can be only in one app (identified by hha_hash)
      // Does this need to change?
      appInfo.cell_data.forEach(cell => {
        let dna_hash_string = Codec.HoloHash.encode("dna", cell.cell_id[0]); // cell.cell_id[0] is binary buffer of dna_hash
        this.anonymous_app_by_dna[dna_hash_string] = { hha_hash, anonymous_agent_ids: appInfo.cell_data.map(cell => Codec.AgentId.encode(cell.cell_id[1])) };
      });
    }
  }

  hhaExists(hha_hash) {
    return Object.values(this.anonymous_app_by_dna).some(anonymous_app => anonymous_app.hha_hash === hha_hash)
  }


  getHostedDnaHashes () {
    return Object.keys(this.anonymous_app_by_dna)
  }

  async signalHandler(signal) {
    const cell_id = signal.data.cellId; // const signal: AppSignal = { type: "Signal" , data: { cellId: [dna_hash, agent_id], payload: decodedPayload }};

    // translate CellId->eventId
    const event_id = this.cellId2eventId(cell_id);

    log.info(`Signal handler is emitting event ${event_id}`);
    log.debug(`Signal content: ${signal.data.payload}`);
    this.ws_server.emit(event_id, Buffer.from(msgpack.encode(signal)).toString('base64'))
  }

  // takes cell_id in binary (buffer) format
  cellId2eventId(cell_id) {
    if (cell_id.length != 2) {
      throw new Error(`Wrong cell id: ${cell_id}`);
    }
    const dna_hash_string = Codec.HoloHash.encode("dna", cell_id[0]); // cell_id[0] is binary buffer of dna_hash
    const { hha_hash, anonymous_agent_ids } = this.anonymous_app_by_dna[dna_hash_string];
    if (!hha_hash) {
      throw new Error(`Can't find hha_hash for DNA: ${dna_hash_string}`);
    }
    const agent_id_string = Codec.AgentId.encode(cell_id[1]); // cell_id[1] is binary buffer of agent_id
    const anonymous = anonymous_agent_ids.includes(agent_id_string)
    const agent_for_signal = anonymous ? 'anonymous' : agent_id_string
      return this.createEventId(agent_for_signal, hha_hash);
  }

  createEventId(agent_id, hha_hash) {
    return `signal:${agent_id}:${hha_hash}`;
  }
}

async function httpRequestStream(req): Promise<any> {
  return new Promise((f, r) => {
    req.pipe(concat_stream(async (buffer) => {
      try {
        f(buffer.toString());
      } catch (err) {
        r(err);
      }
    }));
  });
}

export {
  Envoy
}
