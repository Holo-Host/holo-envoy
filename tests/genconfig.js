const path = require('path');
const log = require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'debug',
});

const fs = require('fs');
const yaml = require('js-yaml');

if ( process.argv.length < 4 ) {
    log.error("Missing input");

    console.log("Usage:\n\n    genconfig.js <port> <output_file>");
    process.exit(1);
}

const port = parseInt( process.argv[2] );
const output_file = process.argv[3];
const output_path = path.resolve( __dirname, "..", output_file );

const config = {
    "environment_path": path.resolve( path.dirname( output_path ), "databases" ),
    "keystore_path": path.resolve( __dirname, "lair" ),
    "admin_interfaces": [{
	"driver": {
	    "type": "websocket",
	    "port": port,
	},
    }],
    "use_dangerous_test_keystore": false,
    "passphrase_service": null,
    "dpki": null,
    "network": null,
};

log.silly("Config: %s", config );
log.normal("Admin Port: %s", config.admin_interfaces[0].driver.port);
const conf_yml = yaml.dump( config );

log.silly("YAML: %s", conf_yml );
log.normal("Writing to: %s", output_path );
fs.writeFileSync( output_path, conf_yml );
