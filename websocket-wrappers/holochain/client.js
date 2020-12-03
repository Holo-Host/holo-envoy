const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const { AdminWebsocket, AppWebsocket }				= require('@holochain/conductor-api');
const ConnectionCheck           = require('../utils.js');

const HOLOCHAIN_WS_CLIENT_OPTS			= {
    "reconnect_interval": 1000,
    "max_reconnects": 300,
};

class HcAdminWebSocket extends AdminWebsocket {
    constructor ( client, connect, ...args ) {
        super( ...args );
        this.client = client;
        this.checkConnection = new ConnectionCheck(client, connect, 'Holochain-WireMessage', HOLOCHAIN_WS_CLIENT_OPTS);
    };
    
    static async init(url) {
        const connect = super.connect;
        const adminWsClient = await super.connect(url);
        return new HcAdminWebSocket(adminWsClient.client, connect);
    }

    opened = async (timeout) => await this.checkConnection.setWsOpened( timeout = 1000 );
    closed = async (timeout) => await this.checkConnection.setWsClosed( timeout = 1000 );
    setSocketInfo = ({ port, name }) => this.checkConnection.setSocketInfo({ port, name });
}

class HcAppWebSocket extends AppWebsocket {
    constructor ( client, connect, ...args ) {
        super( ...args );
        this.client = client;
        this.checkConnection = new ConnectionCheck(client, connect, 'Holochain-WireMessage', HOLOCHAIN_WS_CLIENT_OPTS);
    };
    
    static async init(url) {
        const connect = super.connect;
        const appWsClient = await super.connect(url);
        return new HcAppWebSocket(appWsClient.client, connect);
    }

    opened = async (timeout) => await this.checkConnection.setWsOpened( timeout = 1000 );
    closed = async (timeout) => await this.checkConnection.setWsClosed( timeout = 1000 );
    setSocketInfo = ({ port, name }) => this.checkConnection.setSocketInfo({ port, name });
}

module.exports				= {
    HcAdminWebSocket,
    HcAppWebSocket
}
