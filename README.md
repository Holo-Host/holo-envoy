
# Envoy

## Overview

## Architecture

### Incoming Connections

- **WebSocket Server**		- used by public Agents for hosted hApp connections
- **HTTP Server**		- used by Conductor for wormhole signing requests

### Outgoing Connections

- **Admin (Admin Server)**	- used for creating new hosted Agents and their instances
- **Internal (Conductor)**	- used for service logger traffic
- **Public (Conductor)**	- used for hosted agent traffic


### API Reference

#### Registered events
- `holo/call`
  - `<request>`
    ```javascript
    {
        "agent_id": string,
        "signature": string | false,
        "payload": {
            "instance_id": string,
            "zome": string,
            "function": string,
            "args": {}
        }
    }
    ```
- `holo/latency/test`


- `agent/register`
  - `<agent_id>`
  
- `agent/anonymous/call`
  - `<payload : object>`
    ```javascript
    {
        "instance_id": string,
        "zome": string,
        "function": string,
        "args": {}
    }
    ```
- `agent/{agent_id>/call`
  - `<signature : string>`
  - `<payload : object>`
    ```javascript
    {
        "instance_id": string,
        "zome": string,
        "function": string,
        "args": {}
    }
    ```
- `agent/<agent_id>/wormhole/response`
  - `<id>`
  - `<signature>`
- `agent/<agent_id>/wormhole/request`
  - `<id>`
  - `<entry>`
