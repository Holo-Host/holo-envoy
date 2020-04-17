
# Setup

**Development environment**
- Node.js `12`

**Project employs**
- Typescript
- JSDoc

**Setup**

Nix shell will provide packages listed in [./default.nix](./default.nix) `nativeBuildInputs`
```bash
nix-shell
```

Inside the nix shell
```bash
npm install
```

## Compile (Typescript)

The source is written in Typescript.  Run `npm run compile` or `make build`.



# Testing
Enter `nix-shell` before running tests.

Run all tests
```bash
make test
```

## Unit tests
```bash
make test-unit
```

## Integration tests
```bash
make test-integration
```

## e2e tests
```bash
make test-e2e
```


# Architecture


## Relationships

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


## Concepts

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


## Process

### Requests with no writes

![](https://mermaid.ink/img/eyJjb2RlIjoic2VxdWVuY2VEaWFncmFtXG5cbnBhcnRpY2lwYW50IEMgYXMgQ2xpZW50IChjaGFwZXJvbmUpXG5wYXJ0aWNpcGFudCBFIGFzIEVudm95XG5wYXJ0aWNpcGFudCBIQyBhcyBDb25kdWN0b3JcblxuQy0-PitFOiBjYWxsIHpvbWUgZnVuY3Rpb25cbkUtLT4-SEM6IGxvZyByZXF1ZXN0XG5FLT4-K0hDOiBjYWxsIHpvbWUgZnVuY3Rpb25cbkhDLT4-LUU6IHJlc3VsdFxuRS0tPj5IQzogbG9nIHJlc3BvbnNlXG5FLT4-LUM6IEVudm95IHJlc3BvbnNlXG5DLS0-PkU6IENvbmZpcm0gcmVzcG9uc2VcbkUtLT4-SEM6IGxvZyBjb25maXJtIiwibWVybWFpZCI6eyJ0aGVtZSI6ImRlZmF1bHQifSwidXBkYXRlRWRpdG9yIjpmYWxzZX0)

### Requests that write

![](https://mermaid.ink/img/eyJjb2RlIjoic2VxdWVuY2VEaWFncmFtXG5cbnBhcnRpY2lwYW50IEMgYXMgQ2xpZW50IChjaGFwZXJvbmUpXG5wYXJ0aWNpcGFudCBFIGFzIEVudm95XG5wYXJ0aWNpcGFudCBIQyBhcyBDb25kdWN0b3JcblxuQy0-PitFOiBjYWxsIHpvbWUgZnVuY3Rpb25cbkUtLT4-SEM6IGxvZyByZXF1ZXN0XG5FLT4-K0hDOiBjYWxsIHpvbWUgZnVuY3Rpb25cbkhDLS0-PkM6IHNpZ25pbmcgcmVxdWVzdFxuQy0tPj5IQzogc2lnbmVkIHJlc3BvbnNlXG5hbHQgbXVsdGlwbGUgd3JpdGVzXG5IQy0tPj5DOiBzaWduaW5nIHJlcXVlc3RcbkMtLT4-SEM6IHNpZ25lZCByZXNwb25zZVxuZW5kXG5IQy0-Pi1FOiByZXN1bHRcbkUtLT4-SEM6IGxvZyByZXNwb25zZVxuRS0-Pi1DOiBFbnZveSByZXNwb25zZVxuQy0tPj5FOiBDb25maXJtIHJlc3BvbnNlXG5FLS0-PkhDOiBsb2cgY29uZmlybSIsIm1lcm1haWQiOnsidGhlbWUiOiJkZWZhdWx0In0sInVwZGF0ZUVkaXRvciI6ZmFsc2V9)
