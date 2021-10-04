
# RPC WebSocket API

### `holo/agent/signup`
Request Envoy to set up new installed app for this Agent.  We should have a way to verify that this
Agent is actually unregisterd for the given hApp.

Arguments
- `<hha_hash>`
- `<agent_id>`


### `holo/agent/signin`
Request Envoy to run already installed app for this Agent.

Arguments
- `<hha_hash>`
- `<agent_id>`

### `holo/app_info`
Endpoint for fetching app data, including a list of cell_data and nicknames for each dna in the app.

Arguments
- `<installed_app_id>`


### `holo/call`
Call a zome function.

Arguments
- `<request>`
  ```javascript
  {
      "anonymous"            : boolean,
      "agent_id"             : string,
      "payload": {
          "timestamp"        : number,
          "host_id"          : string,
          "call_spec": {
              "hha_hash"     : string,
              "dna_alias"    : string,
              "cell_id"      : string,
              "zome"         : string,
              "function"     : string,
              "args"         : array
          }
      },
      "service_signature"    : string
  }
  ```


### `holo/wormhole/event`
A simple maintenance endpoint for RPC WebSockets.  It creates a unique event for sending messages
directly to the Agent.  Returns the event name so the client can subscribe to it.

Arguments
- `<agent_id>`


### `holo/wormhole/response`
The client sends signatures for signed entries to this endpoint.

Arguments
- `<id>`
- `<signature>`


### `<agent_id>/wormhole/request`
Each signed-in Agent has a unique endpoint so that the server can send signing requests.

Arguments
- `<id>`
- `<entry>`


### `holo/service/confirm`
The client calls this to confirm that it received a response.

> **NOTE:** We will have to limit the number of responses that can be unconfirmed before a Host
> stops serving that Agent.  Otherwise, there is no incentive for an Agent to confirm the service.

Arguments
- `<request_id>`
- `<agent_id>`
- `<response_hash>`
- `<signature>`
