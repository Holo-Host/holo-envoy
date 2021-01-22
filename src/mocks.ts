import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


function HhaResult ( result ) {
    return result;
}
function HhaError ( result ) {
    return result;
}

async function hha ( zome, func, args ) {
    switch ( `${zome}/${func}` ) {
	case "hha/get_happ":
	    return HhaResult({
				happ_id: 'HeaderHash', // buffer
				happ_bundle: {
					hosted_url: 'http://holofuel.holohost.net',
					happ_alias: 'holofuel-console',
					ui_path: 'path/to/compressed/ui/file',
					name: 'HoloFuel Console',
					dnas: [{
						hash: 'uhCkk...', // hash of the dna, not a stored dht address
						path: '/path/to/compressed/dna/file',
						nick: 'holofuel'
					}],
				},
				provider_pubkey: 'AgentPubKey', // buffer
		});
		break;
	case "hha/get_happ_preferences":
	    return HhaResult({
			provider_pubkey: 'AgentPubKey', // buffer
			max_fuel_before_invoice: 2.0, // f64
			price_per_unit: 0.5, // f64
			max_time_before_invoice: { secs: 15000, nanos: 0 },
		});
	    break;
	default:
	    return HhaError(`Unknown zome function: ${zome}/${func}`);
	    break;
    }
}


async function handler ( call_spec ) {
    log.debug("Calling mock repsonse for: %s->%s.%s", call_spec.cell_id, call_spec.zome, call_spec.function );

    const zome				= call_spec["zome"];
    const func				= call_spec["function"];
    const args				= call_spec["args"];
    
    if ( zome === "hha" )
	return await hha( zome, func, args );
}


export default handler;
