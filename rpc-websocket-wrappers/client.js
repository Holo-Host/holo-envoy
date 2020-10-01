const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const RPCWebSocket			= require('rpc-websockets').Client;

const async_with_timeout		= require('./async_with_timeout.js');
const { TimeoutError }			= async_with_timeout;


class WebSocket extends RPCWebSocket {

    opened ( timeout = 1000 ) {
	log.debug("Waiting for RPC WebSocket client (%s) to be in 'CONNECTED' ready state", this.name );

	if ( this.socket.readyState === 1 ) {
	    log.silly("WebSocket is already in CONNECTED ready state (%s)", this.socket.readyState );
	    return;
	}

	return async_with_timeout(() => {
	    return new Promise((f,r) => {
		const tid		= setTimeout(() => {
		    log.silly("Checking ready state for RPC WebSocket client (%s): %s", this.name, this.socket.readyState );
		    if ( this.socket.readyState === 1 )
			return f();

		    log.silly("Triggering timeout for '%s' because ready state is not 'CONNECTED' withing %sms", this.name, timeout );
		    r();
		}, timeout - 10 );

		return this.on("open", () => {
		    log.silly("'open' event triggered on RPC WebSocket client (%s)", this.name );
		    f();
		    clearTimeout( tid );
		});
	    });
	}, timeout );
    }
    
    closed ( timeout = 1000 ) {
	return async_with_timeout(() => {
	    return new Promise((f,r) => {
		if ( this.socket.readyState === 3 ) {
		    log.silly("RPC WebSocket client (%s) is already in CLOSED state (%s)", this.name, this.socket.readyState );
		    return f();
		}

		return this.on("close", () => {
		    log.silly("'close' event triggered on RPC WebSocket client (%s)", this.name );
		    f();
		});
	    });
	}, timeout );
    }
    
}

module.exports				= WebSocket;
