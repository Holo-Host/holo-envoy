
const { openStdin } = require('process');
const async_with_timeout		= require('./async_with_timeout.js');
const { TimeoutError }			= async_with_timeout;

const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

class ConnectionCheck {
    constructor(client, connect, wsProtocol, { reconnectInterval, maxReconnects }) {
        this.socket = client.socket;
        this.connect = connect;
        this.wsProtocol = wsProtocol;
        this.openListener = () => {};
        this.closeListener = () => {};
        this.name = '';
        this.port = null;
        this.reconnections = 0;
        this.reconnectId = null;
        this.closed = true;
        this.opts = {
            "reconnectInterval": reconnectInterval || null,
            "maxReconnects": maxReconnects || null
        }
      }

    setSocketInfo = ({ port, name }) => {
        if (port) this.port = port;
        if (name) this.name = name;
        return;
    }
      
    checkReconnect = () => {
        if (!this.opts.reconnectInterval || !this.opts.maxReconnects) return;
        if (reconnections < this.opts.maxReconnects && this.closed) {
            const reconnectId = setInterval(this.connect(this.socket.url), this.opts.reconnectInterval);
            this.reconnectId = reconnectId;
            this.reconnections++;
        }
        return;
    }

    setListeners () {
        switch (this.wsProtocol) {
            case 'RPC':
                this.openListener = fn => this.on("open", fn);
                this.closeListener = fn => this.on("close", fn);
                break;

            case 'Holochain-WireMessage':
                this.openListener = fn => this.socket.onopen(fn);
                this.closeListener = fn => this.socket.onopen(fn);
                break;

            default:
                throw new Error('Unrecognized protocol for web client connections.');
        }
    }

    setWsOpened ( timeout = 1000  ) {
        log.debug(`Waiting for ${this.wsProtocol} WebSocket client (%s) to be in 'CONNECTED' ready state...`, this.name );

        this.setListeners();

        if ( this.socket.readyState === 1 ) {
            return Promise.resolve(log.silly("WebSocket is already in CONNECTED ready state (%s)", this.socket.readyState ));
        }
    
        return async_with_timeout(() => {
            return new Promise((f,r) => {
                const tid		= setTimeout(() => {
                    log.silly(`Checking ready state for ${this.wsProtocol} WebSocket client (%s): %s`, this.name, this.socket.readyState );
                    if ( this.socket.readyState === 1 )
                    return f();
    
                    log.silly("Triggering timeout for '%s' because ready state is not 'CONNECTED' withing %sms", this.name, timeout );
                    r();
                }, timeout - 10 );
    
                return this.openListener(() => {
                    this.closed = false;
                    clearInterval(this.reconnectId);
                    this.reconnectId = null;
                    log.silly(`'open' event triggered on ${this.wsProtocol} WebSocket client (%s)`, this.name );
                    f();
                    clearTimeout( tid );
                });
            });
        }, timeout );
    }

    setWsClosed ( timeout = 1000  ) {
        console.log('THIS.NAME port closing !! ', this.name)
        this.setListeners();
        return async_with_timeout(() => {
            return new Promise((f,r) => {
            return this.closeListener(() => {
                this.closed = true;
                checkReconnect();
                log.silly(`'close' event triggered on ${this.wsProtocol} WebSocket client (%s)`, this.name );
                f();
            });
            });
        }, timeout );
    } 
} 
module.exports				= ConnectionCheck