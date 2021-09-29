SHELL		= bash

yarn.lock: package.json
	yarn install
	touch $@
node_modules: yarn.lock
	yarn install

build/index.js:		src/*.ts src/shim.js
	yarn run build
docs/index.html:	build/index.js
	npx jsdoc --verbose -c ./docs/.jsdoc.json --private --destination ./docs build/index.js

.PRECIOUS:	keystore-%.key
.PHONY:		src build docs docs-watch build-watch

# nix-test, nix-install, ...
nix-%:
	nix-shell --run "make $*"

dnas:
	mkdir -p ./dnas
dnas/holo-hosting-app.happ:	dnas
	cp ../holo-hosting-app-rsm/core-app.happ $@
dnas/servicelogger.happ: dnas
	curl 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/v0.1.0-alpha11/servicelogger.happ' -o $@
dnas/elemental-chat.happ: dnas
	curl -LJ 'https://github.com/holochain/elemental-chat/releases/download/v0.2.0-alpha20/elemental-chat.happ' -o $@
dnas/test.happ:	dnas
	curl -LJ 'https://github.com/Holo-Host/dummy-dna/releases/download/v0.4.0/test.happ' -o $@

build: node_modules build/index.js
docs: node_modules docs/index.html
DNAs: dnas/holo-hosting-app.happ dnas/servicelogger.happ dnas/elemental-chat.happ dnas/test.happ

MOCHA_OPTS		= --timeout 10000 --exit

test: build clean-tmp-shim
	make test-unit;
	make test-integration;
	make test-e2e;

test-nix: build
	make test-unit;
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly make test-integration
test-debug: build clean-tmp-shim
	make test-unit-debug;
	make test-integration-debug
	make test-e2e-debug2

test-unit: build lair
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/unit/
	make stop-lair
test-unit-debug: build lair
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/unit/
	make stop-lair

lair:
	RUST_LOG=trace lair-keystore --lair-dir ./script/install-bundles/keystore &> hc-lair.log &
stop-lair:
	killall lair-keystore &
clean-lair:
	rm -rf ./script/install-bundles/keystore

tmp-shim:
	node script/test-shim-init.js &
clean-tmp-shim:
	mkdir -p ./script/install-bundles/shim
	rm -rf ./script/install-bundles/shim/*

setup-conductor:
	make lair
	sleep 5
	make clean-tmp-shim
	make tmp-shim
	sleep 1
	rm -rf ./script/install-bundles/.sandbox
	# enforce using nix version of holochain
	cd script/install-bundles && cargo run -- -h $(shell which holochain)
	make stop-lair
	make clean-tmp-shim
conductor:
	cd script/install-bundles && hc sandbox -f=4444 run -l -p=42233 > ../../hc-conductor.log 2>&1 &
tmp-conductor:
	cd script/install-bundles && hc sandbox run -l -p=42244 > ../../hc-conductor.log 2>&1 &

stop-conductor:
	yarn run stop-conductor
	yarn run stop-hc
clean-conductor:
	rm -rf ./script/install-bundles/.sandbox

test-integration: build DNAs
	make stop-conductor
	make stop-lair
	make setup-conductor
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/integration/
test-integration-debug:	build DNAs stop-lair lair
	make stop-conductor
	make stop-lair
	make setup-conductor
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/integration/

test-e2e: build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-%: build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/test_$*.js
test-e2e-debug: build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e

test-e2e-debug-%: build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/test_$*.js
test-e2e-debug2: build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/

docs-watch:
build-watch:
# above targets are for autocompletion
%-watch:
	npx chokidar -d 3000 'src/**/*.ts' -c "make --no-print-directory $*" 2> /dev/null

clean-docs:
	git clean -df ./docs

CURRENT_BRANCH = $(shell git branch | grep \* | cut -d ' ' -f2)
publish-docs:
	git branch -D gh-pages || true
	git checkout -b gh-pages
	echo "\nBuilding Envoy docs"
	make docs
	ln -s docs v$$( cat package.json | jq -r .version )
	@echo "\nAdding Envoy docs..."
	git add -f docs
	git add v$$( cat package.json | jq -r .version )
	@echo "\nCreating commit..."
	git commit -m "JSdocs v$$( cat package.json | jq -r .version )"
	@echo "\nForce push to gh-pages"
	git push -f origin gh-pages
	git checkout $(CURRENT_BRANCH)

dist/holo_hosting_chaperone.js:
	ln -s node_modules/@holo-host/chaperone/dist dist

# TMP targets
use-local-chaperone:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev ../chaperone
use-yarn-chaperone:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev @holo-host/chaperone
use-yarn-chaperone-%:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev @holo-host/chaperone@$*

#############################
# █░█ █▀█ █▀▄ ▄▀█ ▀█▀ █▀▀ ▄▄ █▀ █▀▀ █▀█ █ █▀█ ▀█▀ █▀
# █▄█ █▀▀ █▄▀ █▀█ ░█░ ██▄ ░░ ▄█ █▄▄ █▀▄ █ █▀▀ ░█░ ▄█
#############################
# How to update holochain?
# In envoy you will have to update the holo-nixpkgs
# make HOLO_REV="HOLO_REV" HC_REV="" DNA_VERSION="" update-hc
# Example use: make HOLO_REV="f0e38fd9895054115d8755572e29a5d3639f69e6" update-hc
# Note: After running this we should run the tests and check

update-hc:
	make HOLO_REV=$(HC_REV) update-holochain
	make HOLO_REV=$(HOLO_REV) update-holo-sha
	make DNA_VERSION=$(DNA_VERSION) update-holo-sha
	git checkout -b update-hc-$(HC_REV)
	git add nixpkgs.nix
	git commit -m hc-rev:$(HC_REV)
	git push origin HEAD

update-dnas:
	@if [ $(DNA_VERSION) ]; then\
		sed -i "24s/.*/  curl 'https:\/\/holo-host.github.io\/holo-hosting-app-rsm\/releases\/downloads\/$(shell echo $(DNA_VERSION) | tr .- _)\/core-app.$(shell echo $(DNA_VERSION) | tr .- _).happ' -o dnas\/holo-hosting-app.happ/" Makefile;\
		sed -i "26s/.*/  curl 'https:\/\/holo-host.github.io\/servicelogger-rsm\/releases\/downloads\/$(shell echo $(DNA_VERSION) | tr .- _)\/servicelogger.$(shell echo $(DNA_VERSION) | tr .- _).happ' -o dnas\/servicelogger.happ/" Makefile;\
		sed -i "28s/.*/  curl -LJ 'https:\/\/github.com\/Holo-Host\/dummy-dna\/releases\/download\/v$(DNA_VERSION)\/test.happ' -o dnas\/test.happ/" Makefile;\
	else \
		echo "No dna version provided"; \
	fi

update-holochain:
	@if [ $(HC_REV) ]; then\
		echo "⚙️  Updating holo-envoy using holochain rev: $(HC_REV)";\
		echo "✔  Updating creates rev in install-script...";\
		echo "✔  Replacing rev...";\
		sed -i -e 's/^holochain_cli_sandbox = .*/holochain_cli_sandbox = {git ="https:\/\/github.com\/holochain\/holochain", rev = "$(HC_REV)", package = "holochain_cli_sandbox"}/' ./script/install-bundles/Cargo.toml;\
		sed -i -e 's/^holochain_conductor_api = .*/holochain_conductor_api = {git ="https:\/\/github.com\/holochain\/holochain", rev = "$(HC_REV)", package = "holochain_conductor_api"}/' ./script/install-bundles/Cargo.toml;\
		sed -i -e 's/^holochain_types = .*/holochain_types = {git ="https:\/\/github.com\/holochain\/holochain", rev = "$(HC_REV)", package = "holochain_types"}/' ./script/install-bundles/Cargo.toml;\
	else \
		echo "No holochain rev provided"; \
	fi

update-holo-sha:
	@if [ $(HOLO_REV) ]; then\
		echo "⚙️  Updating holo-envoy using holo-nixpkgs rev: $(HOLO_REV)";\
		echo "✔  Updating holo-nixpkgs rev in nixpkgs.nix...";\
		echo "✔  Replacing rev...";\
		sed -i -e 's/^  url = .*/  url = "https:\/\/github.com\/Holo-Host\/holo-nixpkgs\/archive\/$(HOLO_REV).tar.gz";/' nixpkgs.nix;\
		echo "✔  Replacing sha256...";\
		sed -i 's/^  sha256 = .*/  sha256 = "$(shell nix-prefetch-url --unpack "https://github.com/Holo-Host/holo-nixpkgs/archive/$(HOLO_REV).tar.gz")";/' nixpkgs.nix;\
	else \
		echo "No holo-nixpkgs rev provided"; \
  fi
