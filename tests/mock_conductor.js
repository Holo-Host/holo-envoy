const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


const { Server : WebSocketServer,
	Client : WebSocket }		= require('../build/wss.js');


class Conductor {

    constructor () {
	this.master			= new WebSocketServer({
	    "port": 42211,
	    "host": "localhost",
	});
	this.service			= new WebSocketServer({
	    "port": 42222,
	    "host": "localhost",
	});
	// this.internal			= new WebSocketServer({
	//     "port": 42233,
	//     "host": "localhost",
	// });
	this.general			= new WebSocketServer({
	    "port": 42244,
	    "host": "localhost",
	});
    }

    async stop () {
	await this.master.close();
	await this.service.close();
	// await this.internal.close();
	await this.general.close();
    }
    
}

module.exports				= Conductor;
