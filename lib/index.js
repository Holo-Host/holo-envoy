const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const { Envoy }				= require("../build/index.js");

log.normal("Starting Envoy server...");
const server				= new Envoy();
