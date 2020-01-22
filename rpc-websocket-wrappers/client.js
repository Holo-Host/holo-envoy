
const RPCWebSocket			= require('rpc-websockets').Client;

const async_with_timeout		= require('./async_with_timeout.js');
const { TimeoutError }			= async_with_timeout;


class WebSocket extends RPCWebSocket {

    opened ( timeout = 1000 ) {
	return async_with_timeout(() => {
	    return new Promise((f,r) => {
		return this.on("open", f);
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
