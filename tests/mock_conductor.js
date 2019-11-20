const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


const { Server : WebSocketServer,
	Client : WebSocket }		= require('../build/wss.js');
const fetch				= require('node-fetch');


class Conductor {

    constructor () {
	this.wormhole_port		= 9676;
	
	this.master			= new WebSocketServer({
	    "port": 42211,
	    "host": "localhost",
	});
	this.service			= new WebSocketServer({
	    "port": 42222,
	    "host": "localhost",
	});
	this.internal			= new WebSocketServer({
	    "port": 42233,
	    "host": "localhost",
	});
	this.general			= new WebSocketServer({
	    "port": 42244,
	    "host": "localhost",
	});
    }

    async stop () {
	await this.master.close();
	await this.service.close();
	await this.internal.close();
	await this.general.close();
    }

    async wormholeRequest ( agent_id, entry ) {
	const resp			= await fetch(`http://localhost:${this.wormhole_port}`, {
	    "method": "POST",
	    "body": JSON.stringify({
		"agent_id": agent_id,
		"payload": entry,
	    }),
	    "timeout": 1000,
	});

	return resp.text();
    }
    
}

module.exports				= Conductor;
