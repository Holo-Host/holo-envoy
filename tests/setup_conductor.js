const path				= require('path');
const log				= require('@whi/stdlog')(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});
const why				= require('why-is-node-running');

const ChildProcess			= require('child_process');
const { Codec }				= require("@holo-host/cryptolib");


let holochain;

function extract_sanitized_lines ( buf ) {
    return buf.toString("utf8")
	.replace(/[\x00-\x09\x0b-\x1a\x1c-\x1F\x7F-\x9F]/g, '') // for some reason there are 1000s
								// of null and control characters.
								// Note: leaving in terminal color
								// character (0x1B) and "\n" (0x0A)
								// line feeds.
	.split("\n");
}

async function start_conductor () {
    if ( holochain === undefined ) {
	const cmd			= "holochain";
	const args			=  "-c conductor-1.toml".split(" "); //  > conductor.log 2>&1 & tail -f conductor.log
	log.debug("Spawning child holochain: %s %s (pwd %s)", cmd, args, process.env.PWD );
	holochain			= ChildProcess.spawn( cmd, args, {
	    "shell": true,
	});
	log.info("Started holochain with PID: %s", holochain.pid );

	const hc_log_filters		= process.env.CONDUCTOR_LOGS === undefined
	      ? null
	      : process.env.CONDUCTOR_LOGS.split(",").map(s => s.trim().toLowerCase());
	log.debug("HC log filters: %s", hc_log_filters );
	
	holochain.stdout.on("data", (data) => {
	    if ( hc_log_filters === null )
		return;
	    
	    let lines			= extract_sanitized_lines( data );
	    for (let line of lines) {
		if ( line.trim() === "" ) // for some reason there are many empty lines
		    continue;
		
		console.log("HOLOCHAIN STDOUT:", line );
	    }
	});

	holochain.stderr.on("data", (data) => {
	    if ( hc_log_filters === null )
		return;

	    let lines			= extract_sanitized_lines( data );
	    for (let line of lines) {
		if ( line.trim() === "" ) // for some reason there are many empty lines
		    continue;
		
		let lc_line		= line.toLowerCase();
		if ( hc_log_filters.some(key => lc_line.includes(key)) ) {
		    console.log("HOLOCHAIN ERROR :", line );
		}
	    }
	});

	holochain.on("close", ( code, signal ) => {
	    log.debug("HOLOCHAIN CLOSED: Exit code %s (signal %s)", code, signal );
	});
	holochain.on("error", ( err ) => {
	    log.error("Child holochain error");
	    console.log( err );
	});
	holochain.on("exit", ( code, signal ) => {
	    log.debug("HOLOCHAIN EXITED: Exit code %s (signal %s)", code, signal );

	    holochain.stdout.destroy();
	    holochain.stderr.destroy();
	});
    }
    else
	throw Error("Conductor is already running");
    
    return holochain;
}

async function stop_conductor () {
    log.debug("Closing Conductor...");
    holochain.kill( 1 ); // SIGTERM (15) | SIGKILL (9)
}


module.exports = {
    "start": start_conductor,
    "stop": stop_conductor,
};
