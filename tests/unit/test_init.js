const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});

// const why				= require('why-is-node-running');
const expect				= require('chai').expect;
const MockConductor			= require('@holo-host/mock-conductor');

const { Envoy }				= require("../../build/index.js");


const ADMIN_PORT			= 42211;

describe("Envoy init unit tests", () => {
    let conductor;

    before(async () => {
	conductor			= new MockConductor( ADMIN_PORT );

	[ 42222, 42233, 42244 ].map( app_port => {
	    conductor.addPort( app_port );
	});
    });

    after(async () => {
	conductor.close();
    });

    it("should initialize and connect to Conductor", async () => {
	const envoy			= new Envoy({});
	let result;
	try {
	    await envoy.connected;

	    conductor.next( [ Buffer.from("hCkkmrkoAHPVf_eufG7eC5fm6QKrW5pPMoktvG5LOC0SnJ4vV1Uv", "base64") ] );
	    result			= await envoy.hcc_clients.master.listDnas();
	} finally {
	    envoy.close();
	}

	expect( result[0].length	).to.equal( 39 );
    });
});
