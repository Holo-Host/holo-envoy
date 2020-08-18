const { Envoy }				= require("./build/index.js");

console.log("Starting Envoy server...");
const envoy				= new Envoy({
    "NS": "/hosting/",
});
console.log("Server has started on port:", envoy.opts.port );
