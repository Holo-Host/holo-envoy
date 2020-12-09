const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

const fetchMock				= require('fetch-mock');
const mock_fetch			= fetchMock.sandbox()

// Mock COMB before loading chaperone
global.COMB				= {
    "connect": () => null,
    "listen": () => null,
}

// Using node crypto instead of WebCrypto because `node-webcrypto-ossl` does not install reliably
global.crypto				= require('crypto');

// Mock browser globals
global.fetch				= mock_fetch;
global.window				= {
    "location": {},
    "parent": {
	"location": {},
    },
    "localStorage": {
	"getItem": () => undefined,
	"setItem": () => undefined,
    },
}
global.document				= {
    "referrer": "https://example.com",
    "location": {
	"href": "https://chaperone.holo.host",
    },
};

const made_up_happ_hash_for_test	= "hCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv";

// Mock Resolver responses
mock_fetch.mock(/.*resolver-dev\.holo.host\/resolve\/hosts\/?/, () => {
    const response			= {
	"hosts":[
	    "localhost"
	],
    };
    log.debug("Mock Resolver response for /resolve/hosts: %s", response );
    return response;
});
mock_fetch.mock(/.*resolver-dev\.holo.host\/resolve\/happId\/?/, () => {
    const response			= {
	"url": "example.com",
	"happ_id": made_up_happ_hash_for_test,
    };
    log.debug("Mock Resolver response for /resolve/happId: %s", response );
    return response;
});
mock_fetch.mock(/.*resolver-dev\.holo.host\/update\/assignHost\/?/, () => {
    const status			= 200;
    log.debug("Mock Resolver response for /update/assignHost: %s", status );
    return status;
});


const { Chaperone }			= require("@holo-host/chaperone");


module.exports = {
    Chaperone,
};
