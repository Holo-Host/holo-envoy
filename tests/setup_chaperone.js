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
    }
}
global.document				= {
    "referrer": "https://example.com",
    "location": {
	"href": "https://chaperone.holo.host",
    },
};

const made_up_happ_hash_for_test	= "QmUgZ8e6xE1h9fH89CNqAXFQkkKyRh2Ag6jgTNC8wcoNYS";

// Mock Resolver responses
mock_fetch.mock(/.*resolver\.holohost.net\/?/, {
    "requestURL": "example.com",
    "hash": made_up_happ_hash_for_test,
    "hosts":[
	"localhost"
    ],
});
mock_fetch.mock(/.*resolver\.holohost.net\/resolve\/hostname\/?/, {
    "hash": made_up_happ_hash_for_test,
});


const { Chaperone }			= require("@holo-host/chaperone");


module.exports = {
    Chaperone,
};
