import path from 'path';
import logger from '@whi/stdlog';

const log = logger(path.basename(__filename), {
  level: process.env.LOG_LEVEL || 'fatal',
});


function ZomeAPIResult(result) {
  return {
    "Ok": result,
  };
}
function ZomeAPIError(result) {
  return {
    "Err": result,
  };
}

async function hha(zome, func, args) {
  switch (`${zome}/${func}`) {
    case "provider/get_app_details":
      return ZomeAPIResult({
        "app_bundle": {
          "happ_hash": "QmVN32n6VHTioNEdhBHPuoSCYFt1wNTh5vv41W7QpNC5wB",
        },
        "payment_pref": [{
          "provider_address": "", // "QmW3ihfvjdgLDBfhj4wK5TJ2McYLu6ENHC8pdtDn5BTae7",
          "dna_bundle_hash": "QmUgZ8e6xE1h9fH89CNqAXFQkkKyRh2Ag6jgTNC8wcoNYS",
          "max_fuel_per_invoice": 0,
          "max_unpaid_value": 0,
          "price_per_unit": 0,
        }],
      });
      break;
    default:
      return ZomeAPIError(`Unknown zome function: ${zome}/${func}`);
      break;
  }
}

async function happ_store(zome, func, args) {
  switch (`${zome}/${func}`) {
    case "happs/get_app":
      return ZomeAPIResult({
        "address": "QmVN32n6VHTioNEdhBHPuoSCYFt1wNTh5vv41W7QpNC5wB",
        "app_entry": {
          "title": "",
          "author": "",
          "description": "",
          "thumbnail_url": "",
          "homepage_url": "",
          "dnas": [{
            "location": "",
            "hash": "QmeEqjFbA9kRcoK7Tw3TJKJ8yQ3SrK2ZLuEbGs5aP2QDug",
            "handle": "holofuel",
          }],
          "ui": null,
        },
        "upvotes": 0,
        "upvoted_by_me": false,
      });
      break;
    default:
      return ZomeAPIError(`Unknown zome function: ${zome}/${func}`);
      break;
  }
}


async function handler(call_spec) {
  log.debug("Calling mock repsonse for: %s->%s.%s", call_spec.instance_id, call_spec.zome, call_spec.function);

  const inst = call_spec["instance_id"];
  const zome = call_spec["zome"];
  const func = call_spec["function"];
  const args = call_spec["args"];

  if (inst === "holo-hosting-app")
    return await hha(zome, func, args);

  if (call_spec.instance_id === "happ-store")
    return await happ_store(zome, func, args);
}


export default handler;
