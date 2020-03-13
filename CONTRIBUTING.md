
# Testing

Enter `nix-shell` before running tests.


### Node modules
```bash
npm install
```


## Unit tests

Run tests
```bash
make test-unit
# or
LOG_LEVEL=silly npx mocha ./tests/unit/
```


## Integration tests

### Setup Holochain

> **NOTE:** by default, Conductor's persistence directory is set to `/var/lib/holochain-conductor/`.
> Make this directory exist and be writable, or change the configuration template before running
> `make conductor-1.toml`.

```bash
make DNAs # Creates local links in ./dist pointing to /nix/store DNAs
make conductor-1.toml
```

Start conductor
```bash
holochain -c conductor-1.toml
# or
make start-hcc-1
```

Convenient make target to erase persistence directory contents
```bash
make reset-hcc
```

### Run integration tests

Holochain conductor must be running
```bash
make test-integration
# or
LOG_LEVEL=silly npx mocha ./tests/integration/
```
