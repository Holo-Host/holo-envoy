var WebSocket = require('rpc-websockets').Client
var WebSocketServer = require('rpc-websockets').Server

// instantiate Server and start listening for requests
var server = new WebSocketServer({
  port: 8080,
  host: 'localhost'
})

// register an RPC method
server.register('holo/sum', function(params) {
  return params[0] + params[1]
})

// ...and maybe a protected one also
server.register('account', function() {
  return ['confi1', 'confi2']
}).protected()

// create an event
// server.event('feedUpdated')

// // get events
// console.log(server.eventList())
//
// // emit an event to subscribers
// server.emit('feedUpdated')

// close the server
// server.close()
