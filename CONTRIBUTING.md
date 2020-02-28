
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

### Local Chaperone
Clone Chaperone locally so that NPM's relative reference is correct (`../chaperone`)
```bash
git clone git@github.com:Holo-Host/chaperone.git --branch 2020-01-fix
```

### Local Service Logger
Clone Service Logger locally so that Nix's relative reference is correct (`../servicelogger`)
```bash
git clone git@github.com:Holo-Host/servicelogger.git --branch hc-0.0.42-alpha4
```

### Setup Holochain

```bash
make DNAs # Creates local links in ./dist pointing to /nix/store DNAs
make conductor-1.toml
```

Start conductor
```bash
holochain -c conductor-1.toml
```

### Run integration tests

Holochain conductor must be running
```bash
make test-unit
# or
LOG_LEVEL=silly npx mocha ./tests/integration/
```
