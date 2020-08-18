const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const RPCWebSocket			= require('rpc-websockets').Client;

const async_with_timeout		= require('./async_with_timeout.js');
const { TimeoutError }			= async_with_timeout;


class WebSocket extends RPCWebSocket {

    opened ( timeout = 1000 ) {
	log.silly(".opened() readyState: %s %s", this.name, this.socket.readyState );
	if ( this.socket.readyState === 1 )
	    return;

	return async_with_timeout(() => {
	    return new Promise((f,r) => {
		log.silly("Waiting for open event on %s", this.name );

		const tid		= setTimeout(() => {
		    if ( this.socket.readyState === 1 )
			return f();

		    log.silly("WebSocket state at timeout: %s %s", this.name, this.socket.readyState );
		    r();
		}, timeout - 10 );

		return this.on("open", () => {
		    log.silly("WebSocket state: %s %s", this.name, this.socket.readyState );
		    f();
		    clearTimeout( tid );
		});
	    });
	}, timeout );
    }
    
    closed ( timeout = 1000 ) {
	return async_with_timeout(() => {
	    return new Promise((f,r) => {
		return this.on("close", () => {
		    f();
		});
	    });
	}, timeout );
    }
    
}

module.exports				= WebSocket;
