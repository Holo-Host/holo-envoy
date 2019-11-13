
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

