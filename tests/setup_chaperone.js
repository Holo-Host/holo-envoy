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
// Filler crypto library (API is different than browser crypto)
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

// Mock Resolver responses
mock_fetch.mock(/.*resolver\.holohost.net\/?/, {
    "requestURL": "example.com",
    "hash": "made_up_happ_hash_for_test",
    "hosts":[
	"localhost"
    ],
});
mock_fetch.mock(/.*resolver\.holohost.net\/resolve\/hostname\/?/, {
    "hash": "made_up_happ_hash_for_test",
});


const { Chaperone }			= require("@holo-host/chaperone");


module.exports = {
    Chaperone,
};
