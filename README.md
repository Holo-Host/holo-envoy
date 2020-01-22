
# Envoy
A server that facilitates communication between hosted Agents and a Host's Holochain Conductor.

## Overview

*TODO: Needs an introduction paragraph*

**Request handling (with wormhole)**
1. Receive request
2. Log service request
3. Call conductor
   - **for each write** transport entry for signing via wormhole
4. Log service response
5. Send response
6. Receive service confirmation
7. Log service confirmation

### Anonymous Agent
These are ephemeral Agent identities that can connect to any Host running an anonymous instance of a
hApp's DNA(s).  When an anonymous connection is made, Envoy does not need to do anything special for
that Agent.

### Signed-in Agent
These are persistent Agent identities created by a user on the client-side.  When a connection is
made, Envoy must know if this is a new (sign-up) or existing user (sign-in).

#### Sign-up 
The Agent is connecting to this Host for the first time and has never used this hApp

*Process*
- register this Agent as a Hosted Agent in Conductor
- start instances for each of the hApp's DNAs
- and continue to sign-in process...
    
#### Sign-in
The Agent has used this hApp before and expects this Host to have their instances running

*Process*
- Register Agent's wormhole endpoint in RPC events

#### Failure modes

- Host does not have expected instances
- Host does not have the correct chains
- Host does not have up-to-date chains

## Architecture

**Envoy is used by**
- Chaperone

**Envoy depends on**
- Conductor
  - Holo Hosting App (HHA)
  - DNAs
    - Read-only instance
    - Service logger instance
    - Hosted Agent instances

### Incoming Connections

- **WebSocket Server**		- used by public Agents for hosted hApp connections
- **HTTP Server**		- used by Conductor for wormhole signing requests

### Outgoing Connections

- **Admin (Admin Server)**	- used for creating new hosted Agents and their instances
- **Internal (Conductor)**	- used for service logger traffic
- **Public (Conductor)**	- used for hosted agent traffic


### API References

- [RPC WebSocket API](API.md)
- [HTTP Server (wormhol) API](wormhole.md)


## Contributors

**Development environment as of 2019/11**
- Node.js `12`

**Project employs**
- Typescript
- JSDoc

**Setup**

Nix shell will provide packages listed in [./default.nix](./default.nix) `nativeBuildInputs`
```bash
nix-shell ./shell.nix
```

Inside the nix shell
```bash
npm install
```

### Compile (Typescript)

The source is written in Typescript.  Run `npm run compile` or `make build`.

### Testing

```bash
npm test
```

#### Unit tests
Unit test components

- Chaperone
- Resolver
- Conductor

Run unit tests
```bash
npm test-unit
```
or
```bash
npx mocha ./tests/unit/
```
