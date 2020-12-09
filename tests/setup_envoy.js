const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const fs				= require('fs');
const { Codec }				= require("@holo-host/cryptolib");

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

async function create_client ( agent_id		= "hCAk7S9HRgczL8oKQ6jfSH7XFd9qVJsBNSyWRrUVnzN8CS7/Xar3",
			       hha	= "hCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv",
			       timeout		= 2000 ) {

    const host_agent_id				= 'd5xbtnrazkxx8wjxqum7c77qj919pl2agrqd3j2mmxm62vd3k' // fs.readFileSync('./AGENTID', 'utf8').trim();
    log.info("Host Agent ID: %s", host_agent_id );

    const client			= new Chaperone({
	"port": envoy.ws_server.port,
	"agent_id": agent_id,
	"hha": hha,
	"timeout": timeout,
	"debug": ["debug", "silly"].includes( (process.env.LOG_LEVEL || "" ).toLowerCase() ),
	"host": "localhost",
	"comb": false,
	host_agent_id,
    });
    
    await client.ready( timeout );
    
    return client;
}


module.exports = {
    "client": create_client,
    "start": start_envoy,
    "stop": stop_envoy,
};
