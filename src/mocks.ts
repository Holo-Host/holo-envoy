import path				from 'path';
import logger				from '@whi/stdlog';

const log				= logger(path.basename( __filename ), {
    level: process.env.LOG_LEVEL || 'fatal',
});


function ZomeAPIResult ( result ) {
    return {
	"Ok": result,
    };
}
function ZomeAPIError ( result ) {
    return {
	"Err": result,
    };
}

async function hha ( zome, func, args ) {
    switch ( `${zome}/${func}` ) {
	case "provider/get_app_details":
	    return ZomeAPIResult({
		"app_bundle": {
		    "happ_hash": args.app_hash,
		},
		"payment_pref": [{
		    "provider_address":         "",
		    "dna_bundle_hash":          "QmUgZ8e6xE1h9fH89CNqAXFQkkKyRh2Ag6jgTNC8wcoNYS",
		    "max_fuel_per_invoice":     0,
		    "max_unpaid_value":         0,
		    "price_per_unit":           0,
		}],
	    });
	    break;
	default:
	    return ZomeAPIError(`Unknown zome function: ${zome}/${func}`);
	    break;
    }
}

async function happ_store ( zome, func, args, happ_store_data ) {
    switch ( `${zome}/${func}` ) {
	case "happs/get_app":
	    return ZomeAPIResult({
		"address":              args.app_hash,
		"app_entry": {
	            "title":            "",
	            "author":           "",
	            "description":      "",
	            "thumbnail_url":    "",
	            "homepage_url":     "",
	            "dnas":		happ_store_data[args.app_hash],
	            "ui":               null,
		},
		"upvotes":              0,
		"upvoted_by_me":        false,
	    });
	    break;
	default:
	    return ZomeAPIError(`Unknown zome function: ${zome}/${func}`);
	    break;
    }
}


async function handler ( call_spec, happ_store_data ) {
    log.debug("Calling mock repsonse for: %s->%s.%s", call_spec.instance_id, call_spec.zome, call_spec.function );

    const inst				= call_spec["instance_id"];
    const zome				= call_spec["zome"];
    const func				= call_spec["function"];
    const args				= call_spec["args"];
    
    if ( inst === "holo-hosting-app" )
	return await hha( zome, func, args );

    if ( call_spec.instance_id === "happ-store" )
	return await happ_store( zome, func, args, happ_store_data );
}


export default handler;
