const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const { Envoy }				= require("../build/index.js");
const { Chaperone }			= require("./setup_chaperone.js");


let envoy;
const clients				= [];

async function start_envoy () {
    envoy				= new Envoy();
    return envoy;
}

async function stop_envoy () {
    for ( let [i,client] of clients.entries() ) {
	const ws			= client.websocket();

	log.debug("Closing Chaperone client[%s]: %s", i, ws.url );
    	await client.close();
    }
    
    log.debug("Closing Envoy...");
    await envoy.close();
}

async function create_client ( agent_id		= "I_am_an_agent_ID",
			       instance_prefix	= "happ-name",
			       timeout		= 2000 ) {

    const client			= new Chaperone({
	"port": envoy.ws_server.port,
	"agent_id": agent_id,
	"instance_prefix": instance_prefix,
	"timeout": timeout,
    });
    
    await client.ready( timeout );
    
    return client;
}


module.exports = {
    "client": create_client,
    "start": start_envoy,
    "stop": stop_envoy,
};
