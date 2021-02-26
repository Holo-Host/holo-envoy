var WebSocket = require('rpc-websockets').Client
var WebSocketServer = require('rpc-websockets').Server

// instantiate Client and connect to an RPC server
var ws = new WebSocket('ws://localhost:8080')

ws.on('open', function() {
  // call an RPC method with parameters
  console.log("---->", ws);
  ws.call('holo/sum', [5, 13]).then(function(result) {
    console.log("result??: ", result);
    require('assert').equal(result, 8)
  })

  // // send a notification to an RPC server
  // ws.notify('openedNewsModule')
  //
  // // subscribe to receive an event
  // ws.subscribe('feedUpdated')
  //
  // ws.on('feedUpdated', function() {
  //   updateLogic()
  // })
  //
  // // unsubscribe from an event
  // ws.unsubscribe('feedUpdated')
  //
  // // login your client to be able to use protected methods
  // ws.login({'username': 'confi1', 'password':'foobar'}).then(function() {
  //   ws.call('account').then(function(result) {
  //     require('assert').equal(result, ['confi1', 'confi2'])
  //   })
  // }).catch(function(error) {
  //   console.log('auth failed')
  // })

  // close a websocket connection
  ws.close()
})
