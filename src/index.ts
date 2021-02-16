import path from 'path';
import fs from 'fs';
import logger from '@whi/stdlog';
import crypto from 'crypto';
import request from 'request';
import http from 'http';
import concat_stream from 'concat-stream';
import SerializeJSON from 'json-stable-stringify';
import { Codec } from '@holo-host/cryptolib';
import { Package } from '@holo-host/data-translator';
import { HcAdminWebSocket, HcAppWebSocket } from "../websocket-wrappers/holochain/client";
import { Server as WebSocketServer } from './wss';

const requestUrl = request;

const log = logger(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});

const sha256 = (buf) => crypto.createHash('sha256').update(Buffer.from(buf)).digest();
const digest = (data) => Codec.Digest.encode(sha256(typeof data === "string" ? data : SerializeJSON(data)));

const WS_SERVER_PORT = 4656; // holo
const WH_SERVER_PORT = 9676; // worm
const RPC_CLIENT_OPTS = {
  "reconnect_interval": 1000,
  "max_reconnects": 300,
};
const CONDUCTOR_TIMEOUT = RPC_CLIENT_OPTS.reconnect_interval * RPC_CLIENT_OPTS.max_reconnects;
const NAMESPACE = "/hosting/";
const READY_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

interface CallSpec {
  hha_hash: string;
  dna_alias: string;
  cell_id?: string;
  zome?: string;
  function?: string;
  args?: any;
}

interface AppDna {
  nick?: string;
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
  app_port_number?: number;
}

class HoloError extends Error {

  constructor(message) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(message);

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HoloError);
    }

    this.name = 'HoloError';

    // Fix for Typescript
    //   - https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, HoloError.prototype);
  }

  toJSON() {
    return {
      "name": this.name,
      "message": this.message,
    };
  }
}

async function promiseMap (array, fn) {
  const resolvedArray = await array;
  const promiseArray = resolvedArray.map(fn);
  const resolved = await Promise.all(promiseArray);
  return resolved;
}

class Envoy {
  ws_server: any;
  http_server: any;
  opts: EnvoyConfig;
  conductor_opts: any;
  connected: any;
  serverClients: object = {};

  payload_counter: number = 0;
  pending_confirms: object = {};
  pending_signatures: object = {};
  anonymous_agents: any = {};

  hcc_clients: any = {};
  dna2hha: any = {};

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
    this.startWebsocketServer();
    this.startHTTPServer();
  }

  async connections() {
    try {
      const ifaces = this.conductor_opts.interfaces;
      this.hcc_clients.admin = await HcAdminWebSocket.init(`ws://localhost:${ifaces.admin_port}`);
      this.hcc_clients.app = await HcAppWebSocket.init(`ws://localhost:${ifaces.app_port}`, this.signalHandler.bind(this));
    } catch (err) {
      console.error(err);
    }

    Object.keys(this.hcc_clients).map(k => {
      this.hcc_clients[k].setSocketInfo({
        name: k,
        port: this.conductor_opts.interfaces[`${k}_port`]
      });
      log.info("Conductor client '%s' configured for port (%s)", k, this.hcc_clients[k].connectionMonitor.port);
    });

    const clients = Object.values(this.hcc_clients);
    return Promise.all(
      clients.map(async (client: any) => {
        await client.opened(CONDUCTOR_TIMEOUT)
          .catch(err => {
            log.fatal("Conductor client '%s' failed to connect: %s", client.connectionMonitor.name, String(err));
          });

        log.debug("Conductor client '%s' is 'CONNECTED': readyState = %s", client.connectionMonitor.name, client.connectionMonitor.socket.readyState);
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

    await this.connected;

    this.ws_server.on("connection", async (socket, request) => {
      // path should contain the HHA ID and Agent ID so we can do some checks and alert the
      // client-side if something is not right.
      log.silly("Incoming connection from %s", request.url);
      const url = new URL(request.url, "http://localhost");

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

      if (anonymous) {
        log.debug(`Adding Agent ${agent_id} to anonymous list with HHA ID ${hha_hash}`);
        this.anonymous_agents[agent_id] = hha_hash;
      }

      // Signal is a message initiated in conductor which is sent to UI. In case to be able to route signals
      // to appropriate agents UIs we need to be able to identify connection based on agent_id and hha_hash.

      // make sure dna2hha entry exists for given hha
      await this.recordHha(hha_hash);
      let connection_id = this.createConnectionId(agent_id, hha_hash);

      // save socket in serverClients so that we can later find it and send signal
      // TODO: what with anonymous?
      this.serverClients[connection_id] = socket;
      log.debug(`Registering socket for ${connection_id}`);

      // TODO: delete
      // Create event with unique id so that chaperone can subscribe to it.
      // Events can be passed only to logged-in users, otherwise there's no way to map
      // signal -> agent+app combo
      // On login connection is re-established with new agent.
      // Don't panic if event already created (might happen on reconnecting)
      // if (anonymous) {
      //   log.debug(`Skipping creating signal event - anonymous user`);
      // } else {
      //   log.debug(`Creating signal event ${event_id}`);
      //   try {
      //     this.ws_server.event(event_id, this.opts.NS);
      //   } catch(e) {
      //     log.debug(`Event ${event_id} already created`);
      //   }
      // }

      socket.on("close", async () => {
        log.normal("Socket is closing for Agent (%s) using HHA ID %s", agent_id, hha_hash);

        delete this.serverClients[connection_id];

        if (anonymous) {
          log.debug("Remove anonymous Agent (%s) from anonymous list", agent_id);
          delete this.anonymous_agents[agent_id];
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
          console.error(e);
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
    this.ws_server.register("holo/agent/signup", async ([hha_hash, agent_id]) => {
      log.normal("Received sign-up request from Agent (%s) for HHA ID: %s", agent_id, hha_hash);

      const failure_response = (new HoloError("Failed to create a new hosted agent")).toJSON();

      const anonymous_instance_app_id = hha_hash;
      const hosted_agent_instance_app_id = `${hha_hash}:${agent_id}`;

      log.info("Retrieve the hosted app cell_data using the anonymous installed_app_id: '%s'", anonymous_instance_app_id);
      const appInfo = await this.callConductor("app", { installed_app_id: anonymous_instance_app_id });

      if (!appInfo) {
        log.error("Failed during hosted app's AppInfo call: %s", appInfo);
        return failure_response;
      }

      log.silly('NUMBER OF DNAs in the hosted happ: ', appInfo.cell_data.length)
      log.silly('AppInfo on sign-up: ', appInfo)

      log.silly("Hosted App Cell Data: %s", appInfo.cell_data);
      log.info("Found %s DNA(s) for the app bundle with HHA ID: %s", appInfo.cell_data.length, hha_hash);

      const buffer_agent_id = Codec.AgentId.decodeToHoloHash(agent_id);
      log.info("Encoded Agent ID (%s) into buffer form: %s", agent_id, buffer_agent_id);

      let failed = false;
      try {
        let adminResponse;
        // - Install App - This admin function creates cells for each dna with associated nick, under the hood.
        try {
          log.info("Installing App with HHA ID (%s) as Installed App ID (%s) ", hha_hash, hosted_agent_instance_app_id);
          let dnas;

          if (this.opts.hosted_app && this.opts.hosted_app!.dnas && this.opts.mode === Envoy.DEVELOP_MODE) {
            dnas = this.opts.hosted_app.dnas;
					} else {
            const installedDnas = appInfo.cell_data.map(([cell_id, dna_alias]) => ({ nick: dna_alias, hash: cell_id[0] }));
            log.debug('installedDnas : %s', installedDnas);
            dnas = installedDnas;
					}

          adminResponse = await this.callConductor("admin", 'installApp', {
            installed_app_id: hosted_agent_instance_app_id,
            agent_key: buffer_agent_id,
            dnas
          });

          if (adminResponse.type !== "success") {
            log.error("Conductor 'installApp' returned non-success response: %s", adminResponse);
            failed = true
            throw (new HoloError(`Failed to complete 'installApp' for installed_app_id'${hosted_agent_instance_app_id}'.`)).toJSON();
          }
        } catch (err) {
          if (err.message.toLowerCase().includes("duplicate cell")) {
            log.warn("Cell (%s) already exists in Conductor", hosted_agent_instance_app_id);
          } else {
            log.error("Failed during 'installApp': %s", String(err));
            throw err;
          }
        }

        // Activate App - Add the Installed App to a hosted interface.
        try {
          log.info("Activating Installed App (%s)", hosted_agent_instance_app_id);
          adminResponse = await this.callConductor("admin", 'activateApp', { installed_app_id: hosted_agent_instance_app_id });

          if (adminResponse.type !== "success") {
            log.error("Conductor 'activateApp' returned non-success response: %s", adminResponse);
            failed = true
            throw (new HoloError(`Failed to complete 'activateApp' for installed_app_id'${hosted_agent_instance_app_id}'.`)).toJSON();
          }
        } catch (err) {
          if (err.message.toLowerCase().includes("already in interface"))
            log.warn("Cannot Activate App: Installed App ID (%s) is already added to hosted interface", hosted_agent_instance_app_id);
          else {
            log.error("Failed during 'activateApp': %s", String(err));
            throw err;
          }
        }

        // Attach App to Interface - Connect app to hosted interface and start app (ie: spin up all cells within app bundle)
        try {
          let app_port

          if ((this.opts.app_port_number === 0 || this.opts.app_port_number) && this.opts.mode === Envoy.DEVELOP_MODE) {
            log.info("Defaulting to port provided in opts config.  Attaching App to port (%s)", this.opts.app_port_number);
            // NOTICE: MAKE SURE THIS PORT IS SET TO THE WS PORT EXPECTED IN THE UI
            app_port = this.opts.app_port_number;
          } else {
            app_port = this.conductor_opts.interfaces.app_port;
          }

          log.info("Starting installed-app (%s) on port (%s)", hosted_agent_instance_app_id, app_port);

          adminResponse = await this.callConductor("admin", 'attachAppInterface', { port: app_port });

          if (adminResponse.type !== "success") {
            log.error("Conductor 'attachAppInterface' returned non-success response: %s", adminResponse);
            failed = true
            throw (new HoloError(`Failed to complete 'attachAppInterface' for installed_app_id '${hosted_agent_instance_app_id}'.`)).toJSON();
          }
        } catch (err) {
          if (err.message.toLowerCase().includes("already active"))
            log.warn("Cannot Start App: Intalled-app (%s) is already started", hosted_agent_instance_app_id);
          else {
            log.error("Failed during 'attachAppInterface': %s", String(err));
            throw err;
          }
        }

      } catch (err) {
        failed = true;
        log.error("Failed during DNA processing for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, String(err));
      }

      if (failed === true) {
        // Should rollback cells that were already created
        // ^^ check to see if is already being done in RSM.
        log.error("Failed during sign-up process for Agent (%s) HHA ID (%s): %s", agent_id, hha_hash, failure_response);

        return failure_response;
      }

      // - return success
      log.normal("Completed sign-up process for Agent (%s) HHA ID (%s)", agent_id, hha_hash);
      return true;
    }, this.opts.NS);


    // Chaperone AppInfo Call to Envoy Server
    this.ws_server.register("holo/app_info", async ({ installed_app_id }) => {
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

      const response_hash = digest(appInfo);
      const response_id = response_hash;

      log.normal("Completed AppInfo call for installed_app_id (%s) with response_id (%s)", installed_app_id, response_id);

      return new Package(appInfo, { "type": "success" }, { response_id });
    }, this.opts.NS);


    // Chaperone ZomeCall to Envoy Server
    this.ws_server.register("holo/call", async ({ anonymous, agent_id, payload, service_signature }) => {
      log.silly("Received request: %s", payload.call_spec);

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

      const call_spec = payload.call_spec;
      const call_spec_args = (typeof call_spec.args === "object") ? Object.keys(call_spec.args).join(", ") : call_spec.args;
      log.normal("Received zome call request from Agent (%s) with spec: %s::%s->%s( %s )",
        agent_id, call_spec.cell_id, call_spec.zome, call_spec.function, call_spec_args);

      // - Servicelogger request. If the servicelogger.log_{request/response} fail (eg. due
      // to bad signatures, wrong host_id, or whatever), then the request cannot proceed, and
      // we'll immediately return an error w/o a response_id or result.
      let request;

      log.debug("Log service request (%s) from Agent (%s)", service_signature, agent_id);
      request = await this.logServiceRequest(agent_id, payload, service_signature);

      // ZomeCall to Conductor App Interface
      let zomeCall_response, holo_error
      try {
        const zomeCallArgs = (typeof call_spec.args === 'object')
          ? Object.entries(call_spec.args).map(([k, v]) => {
            if (!k || !v) return {};
            return `${k} : ${typeof v}`
          }).join(", ")
          : call_spec.args
        log.debug("Calling zome function %s->%s( %s ) on cell_id (%s), cap token (%s), and provenance (%s):", () => [
          call_spec.zome, call_spec.function, zomeCallArgs, call_spec.cell_id, null, agent_id]);

        // In case of no call args, convert empty obj to null
        if (Object.keys(call_spec.args).length <= 0) {
          log.debug('No call_spec.args, converting value to null for zomeCall.');
          call_spec.args = null
        };

        const hosted_app_cell_id = call_spec["cell_id"];

        zomeCall_response = await this.callConductor("app", {
          // QUESTION: why we can't just pass directly in the cell_id received back from appInfo call...
          "cell_id": [Buffer.from(hosted_app_cell_id[0]), Buffer.from(hosted_app_cell_id[1])],
          "zome_name": call_spec["zome"],
          "fn_name": call_spec["function"],
          "payload": call_spec["args"],
          "cap": null, // Note: when null, this call will pass when the agent has an 'Unrestricted' status (this includes all calls to an agent's own chain)
          "provenance": Codec.AgentId.decodeToHoloHash(agent_id),
        });
      } catch (err) {
        log.error("Failed during Conductor call: %s", String(err));
        zomeCall_response = {};

        if (err.message.includes("Failed to get signatures from Client")) {
          let new_message = anonymous === true
            ? "Agent is not signed-in"
            : "We were unable to contact Chaperone for the Agent signing service.  Please check ...";

          log.warn("Setting error response to wormhole error message: %s", new_message);
          holo_error = (new HoloError(new_message)).toJSON();
        }
        else if (err instanceof HoloError) {
          log.warn("Setting error response to raised HoloError: %s", String(err));
          holo_error = err.toJSON();
        }
        else {
          log.fatal("Conductor call threw unknown error: %s", String(err));
          console.error(err);
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

				const host_metrics = {
					"cpu": 1,
          "bandwidth": 1
				};

				const weblog_compat = {
					source_ip: "100:0:0:0",
					status_code: 200
				}

				log.debug("Form service response for signed request (%s): %s", service_signature, JSON.stringify(request, null, 4));
				host_response = this.logServiceResponse(zomeCall_response, host_metrics, weblog_compat);
				log.info("Service response by Host: %s", JSON.stringify(host_response, null, 4));

				// Use response_id to act as waiting ID
				const response_id = host_response.response_hash;

				log.info("Adding service call ID (%s) to waiting list for client confirmations for agent (%s)", response_id, agent_id);
				this.addPendingConfirmation(response_id, request, host_response, agent_id);

				log.normal("Returning host reponse (%s) for request (%s) with signature (%s) as response_id (%s) to chaperone",
          JSON.stringify(host_response, null, 4), JSON.stringify(request, null, 4), JSON.stringify(service_signature), response_id);

        response_message = new Package({ zomeCall_response }, { "type": "success" }, { response_id, host_response });
      }

      return response_message;
    }, this.opts.NS);

    // Chaperone Call to Envoy Server to confirm service
    this.ws_server.register("holo/service/confirm", async ([response_id, response_signature, confirmation]) => {
      log.normal("Received confirmation request for call response (%s)", response_id);
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
        log.debug("Log service confirmation for Response ID (%s) for agent_id (%s)", response_id, agent_id);
        service_log = await this.logServiceConfirmation(client_req, host_res, confirmation);
        log.info("Service confirmation log hash: %s", service_log);
      } catch (err) {
        const error = `servicelogger.log_service threw: ${String(err)}`
        log.error("Failed during service confirmation log: %s", error);
        console.error(err);

        this.removePendingConfirmation(response_id);

        const errorPack = Package.createFromError("HoloError", err);
        log.normal('Returning error: ', errorPack);

        return errorPack;

      }

      this.removePendingConfirmation(response_id);

      log.normal("Confirmation for call with response ID (%s) is complete", response_id);
      // - return success
      // updated to match hhdt success message format
      return new Package(true, { "type": "success" }, { response_id });
    }, this.opts.NS);
  }

  // --------------------------------------------------------------------------------------------

  // WORMHOLE HTTP SERVER

  // this is currently not used
  async startHTTPServer() {
    let wormhole_counter = 0;
    function prefix(msg) {
      return `\x1b[95mWORMHOLE #${wormhole_counter}: \x1b[0m` + msg;
    }

    this.http_server = http.createServer(async (req, res) => {
      let whid = wormhole_counter++;
      log.silly(prefix("Received wormhole %s request with content length: %s"), req.method, req.headers["content-length"]);

      // Warn if method is not POST or Content-type is incorrect
      const body: string = await httpRequestStream(req);
      log.debug(prefix("Actually HTTP body length: %s"), body.length);
      log.silly(prefix("HTTP Body: %s"), body);

      let agent_id, payload, signature;
      try {
        let data = JSON.parse(body);
        agent_id = data.agent_id;
        payload = data.payload;
      } catch (err) {
        log.error(prefix("Failed to handle HTTP request: %s"), err);
        log.silly(prefix("HTTP Request: %s"), body);
      }

      try {
        log.debug(prefix("Conductor needs Agent (%s) to sign payload: %s"), agent_id, payload);
        signature = await this.signingRequest(agent_id, payload);
      } catch (err) {
        log.error("WORMHOLE #%s: Signing request error: %s", wormhole_counter, String(err));
        res.writeHead(400);
        res.end(`${err.name}: ${err.message}`);
      }

      log.silly(prefix("Returning signature (%s) for payload: %s"), signature, payload);
      res.end(signature);
    });
    this.http_server.on('clientError', (err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    this.http_server.listen(WH_SERVER_PORT);
  }

  signingRequest(agent_id: string, payload: string, timeout = 5_000) {
    const payload_id = this.payload_counter++;
    log.normal("Opening a request (#%s) for Agent (%s) signature of payload: typeof '%s'", payload_id, agent_id, typeof payload);

    return new Promise((f, r) => {
      const event = `${agent_id}/wormhole/request`;

      if (this.ws_server.eventList(this.opts.NS).includes(event) === false) {
        log.warn("Trying to get signature from unknown Agent (%s)", agent_id);
        if (Object.keys(this.anonymous_agents).includes(agent_id))
          throw new Error(`Agent ${agent_id} cannot sign requests because they are anonymous`);
        else
          throw new Error(`Agent ${agent_id} is not registered.  Something must have broke?`);
      }

      let toid = setTimeout(() => {
        log.error("Failed during signing request #%s with timeout (%sms)", payload_id, timeout);
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
    await Promise.all(clients.map((client: any) => client.connectionMonitor.socket.close()));
    log.info("All Conductor clients are closed");

    await this.ws_server.close();
    log.info("RPC WebSocket server is closed");

    await this.http_server.close();
    log.info("HTTP server is closed");
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

  async callConductor(client, call_spec, args: any = {}) {
    log.normal("Received request to call Conductor using client '%s' with call spec of type '%s'", client, typeof call_spec);
    let interfaceMethod, methodName, callAgent;
    try {
      if (typeof client === "string")
        client = this.hcc_clients[client];

      let ready_state = client.connectionMonitor.socket.readyState;
      if (ready_state !== 1) {
        log.silly("Waiting for 'CONNECTED' state because current ready state is %s (%s)", ready_state, READY_STATES[ready_state]);
        await client.opened();
      }

      // Assume the interfaceMethod is using a client that calls an AppWebsocket interface, unless `call_spec` is a function (admin client).
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
        log.debug("\nZome Call spec details - called with cap token (%s), provenance (%s), cell_id(%s), and zome fn call: %s->%s( %s )", () => [
          call_spec.cap, call_spec.provenance, call_spec.cell_id, call_spec.zome_name, call_spec.fn_name, payload_log]);
        args = call_spec;
      }
    } catch (err) {
      log.debug("CallConductor preamble threw error: ", err);
      throw new HoloError(`callConductor preamble threw error: ${String(err)}}`, );
    }

    let resp;
    try {
      log.silly("Calling Conductor method (%s) over client '%s' with input %s: ", methodName, client.connectionMonitor.name, JSON.stringify(args));
      try {
        resp = await interfaceMethod(args);
      } catch (error) {
        throw new Error(`CONDUCTOR CALL ERROR: ${JSON.stringify(error)}`);
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

      if (err.code === -32000) {
        if (err.data.includes("response from service is not success")) {
          log.error("Failed during Conductor call because of a signing request error: %s", err.data);
          throw new HoloError("Failed to get signatures from Client");
        }
        else {
          log.fatal("Failed during Conductor call with RPC Internal Error: %s -> %s", err.message, err.data);
          throw new HoloError(`Unknown -32000 Error: ${JSON.stringify(err)}`);
        }
      } else if (err instanceof Error) {
        log.error("Failed during Conductor call with error: %s", String(err));
        throw new HoloError(String(err));
      } else {
        log.fatal("Failed during Conductor call with unknown error: %s", err);
        throw new HoloError(`Unknown RPC Error: ${JSON.stringify(err)}`);
      }
    }

    log.normal("Conductor call returned successful '%s' response: %s ", typeof resp, resp);
    return resp;
  }


  // --------------------------------------------------------------------------------------------

  // Service Logger Methods

  addPendingConfirmation(response_id, client_req, host_res, agent_id) {
    log.silly("Add response ID (%s) to pending confirmations for Agent (%s) with client request (%s) and host response (%s)", response_id, agent_id, client_req, host_res);
    this.pending_confirms[response_id] = {
      agent_id,
      client_req,
      host_res
    };
  }

  getPendingConfirmation(response_id) {
    log.info("Get response ID (%s) from pending confirmations", response_id);
    return this.pending_confirms[response_id];
  }

  removePendingConfirmation(response_id) {
    log.info("Remove response ID (%s) from pending confirmations", response_id);
    delete this.pending_confirms[response_id];
  }

  async logServiceRequest(agent_id, payload, signature) {
    log.normal("Processing service logger request (%s)", signature);

    const call_spec = payload.call_spec;
    const args_hash = digest(call_spec["args"]);

    log.debug("Using argument digest: %s", args_hash);
    const request_payload = {
      "timestamp": [(new Date(payload.timestamp)).getTime(), 0],
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
    const response_hash = digest(response);
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

  async logServiceConfirmation(client_request, host_response, confirmation) {
    log.normal("Processing service logger confirmation (%s) for client request (%s) with host response", confirmation, client_request, host_response);

    const hha_hash = client_request.request.call_spec.hha_hash;

    let servicelogger_installed_app_id;

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
    const servicelogger_cell_id = appInfo.cell_data[0][0];
    const buffer_host_agent_servicelogger_id = servicelogger_cell_id[1];

    /******************** WORMHOLE SIGNING WORK AROUND ********************/
		// TEMPORARY: signing in via servicelogger
		// REMOVE THIS BLOCK ONCE WORMHOLE IMPLEMENTATION COMPLETE

    let temp_request_signature, temp_response_signature, temp_confirm_signature
    try {
      temp_request_signature = await this.callConductor("app", {
        "cell_id": servicelogger_cell_id,
        "zome_name": "service",
        "fn_name": "sign_request",
        "payload": client_request.request,
        "cap": null,
        "provenance": buffer_host_agent_servicelogger_id,
      });
    } catch (error) {
      log.error("Failed to sign REQUEST in wormhole workaround: ", error);
      throw new Error(JSON.stringify(error))
    }

    try {
      temp_response_signature = await this.callConductor("app", {
        "cell_id": servicelogger_cell_id,
        "zome_name": "service",
        "fn_name": "sign_response",
        "payload": host_response.response_hash,
        "cap": null,
        "provenance": buffer_host_agent_servicelogger_id,
      });
    } catch (error) {
      log.error("Failed to sign RESPONSE in wormhole workaround: ", error);
      throw new Error(JSON.stringify(error))
    }

    try {
      temp_confirm_signature = await this.callConductor("app", {
        "cell_id": servicelogger_cell_id,
        "zome_name": "service",
        "fn_name": "sign_confirmation",
        "payload": confirmation.confirmation,
        "cap": null,
        "provenance": buffer_host_agent_servicelogger_id,
      });
    } catch (error) {
      log.error("Failed to sign CONFIRMATION in wormhole workaround': ", error);
      throw new Error(JSON.stringify(error))
    }

    client_request.request_signature = temp_request_signature;
    host_response.signed_response_hash = temp_response_signature;
    confirmation.confirmation_signature = temp_confirm_signature;

    log.silly("Recording service confirmation with payload: activity: { request: %s, response: %s, confimation: %s }", client_request, host_response, confirmation);
    const resp = await this.callConductor("app", {
      "cell_id": servicelogger_cell_id,
      "zome_name": "service",
      "fn_name": "log_activity",
      "payload": {
        "request": client_request,
        "response": host_response,
        "confirmation": confirmation,
      },
      cap: null,
      provenance: buffer_host_agent_servicelogger_id,
    });

    if (resp) {
      log.silly('\nFinished Servicelogger confirmation: ', resp);

      log.info("Returning success response for confirmation log (%s): typeof '%s, %s'", confirmation, typeof resp, resp);
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
        let dna_hash_string = Codec.AgentId.encode(cell[0][0]); // cell[0][0] is binary buffer of dna_hash
        this.dna2hha[dna_hash_string] = hha_hash;
      });
    }
  }

  hhaExists(hha_hash) {
    return (Object.values(this.dna2hha).includes(hha_hash));
  }

  async signalHandler(signal) {
    let cell_id = signal.data.cellId; // const signal: AppSignal = { type: msg.type , data: { cellId: [dna_hash, agent_id], payload: decodedPayload }};

    // translate CellId->eventId
    const connection_id = this.cellId2connectionId(cell_id);

    log.debug(`Signal handler is sending signal to socket ${connection_id}`);
    let socket = this.serverClients[connection_id];

    if (socket && socket.readyState === 1)
      {
        socket.send(signal.data.payload, () => {
          log.debug(`Sent signal with content: ${signal.data.payload}`);
        });
      } else {
        log.debug(`No client connected with this connection ID`);
      }

    // TODO: delete
    // log.debug(`Signal handler is emitting event ${event_id}`);
    // log.debug(`Signal content: ${signal.data.payload}`);
    // this.ws_server.emit(event_id, signal)
  }

  // takes cell_id in binary (buffer) format
  cellId2connectionId(cell_id) {
    if (cell_id.length != 2) {
      throw new Error(`Wrong cell id: ${cell_id}`);
    }
    let dna_hash_string = Codec.AgentId.encode(cell_id[0]); // cell_id[0] is binary buffer of dna_hash
    let hha_hash = this.dna2hha[dna_hash_string];
    if (!hha_hash) {
      throw new Error(`Can't find hha_hash for DNA: ${cell_id[0]}`);
    }
    let agent_id_string = Codec.AgentId.encode(cell_id[1]); // cell_id[1] is binary buffer of agent_id
    return this.createConnectionId(agent_id_string, hha_hash);
  }

  createConnectionId(agent_id, hha_hash) {
    return `socket:${agent_id}:${hha_hash}`;
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
