import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


const RPCWebSocketServer		= require('rpc-websockets').Server;
const WebSocket				= require('../build/client.js');


class WebSocketServer extends RPCWebSocketServer {

    port		: number;
    clients		: any		= [];

    constructor ( ...args ) {
	super( ...args );
	const options			= args[0] || {};
	
	this.port			= options.port;
	
	log.info("Started RPC WebSocket Server on port %s", this.port );
    }
    
    register ( method, fn ) {
	return super.register( method, async function ( ...args ) {
	    try {
		return await fn.apply( this, args );
	    } catch ( err ) {
		log.error("Handler '%s' threw an error: %s", method, String(err) );
		return {
		    "error": err.name,
		    "message": err.message,
		};
	    }
	});
    }

    unregister ( name, ns = "/" ) {
	delete this.namespaces[ns].rpc_methods[name];
    }
    
    once ( method, handler ) {
	const self			= this;
	this.register( method, async function ( ...args ) {
	    self.unregister( method );
	    return await handler.apply( this, args );
	});
    }

    async client () {
	const rws			= new WebSocket(`ws://localhost:${this.port}`);
	await rws.opened();
	
	this.clients.push( rws );
	
	return rws;
    }
    
    async close () {
	log.info("Closing %s websocket clients", this.clients.length );

	log.debug("this.clients (%s) array? %s = %s", typeof this.clients, Array.isArray(this.clients), this.clients );
	
	for ( let [i,rws] of this.clients.entries() ) {
	    const ws			= rws.socket;
	    
	    log.debug("Closing websocket client[%s]: %s", i, ws.url );
	    rws.close();
	    
	    log.silly("Ready state: %s",  ws.readyState );
	    await rws.closed();
	    log.silly("Ready state: %s",  ws.readyState );
	}
	
	log.debug("Closing this");
	return super.close();
    }
    
}

export default WebSocketServer;
export {
    WebSocketServer	as Server,
    WebSocket		as Client,
}
