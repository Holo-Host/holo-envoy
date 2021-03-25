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
kill-holochain:

dnas:
	mkdir -p ./dnas
dnas/holo-hosting-app.happ:	dnas
	curl 'https://holo-host.github.io/holo-hosting-app-rsm/releases/downloads/v0.1.0-alpha1/holo-hosting-app.happ' -o $@
dnas/servicelogger.happ:	dnas
	curl 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/v0.1.0-alpha2/servicelogger.happ' -o $@
dnas/test.happ:	dnas
	curl -LJ 'https://github.com/Holo-Host/dummy-dna/releases/download/v0.2.0/test.happ' -o $@

build: node_modules build/index.js
docs: node_modules docs/index.html
DNAs: dnas/test.happ dnas/holo-hosting-app.happ dnas/servicelogger.happ

MOCHA_OPTS		= --timeout 10000 --exit

test:			build
	make test-unit;
	make test-integration;
	make test-e2e;

test-nix:		build
	make test-unit;
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly make test-integration
test-debug:		build
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/unit/
	make test-integration-debug
	make test-e2e-debug2

test-unit:		build lair
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/unit/
	make stop-lair
test-unit-debug:	build lair
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
	cd script/install-bundles && cargo run
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

test-integration:	build DNAs
	make stop-conductor
	make stop-lair
	make setup-conductor
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/integration/
test-integration-debug:	build DNAs stop-lair lair
	make stop-conductor
	make setup-conductor
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/integration/

test-e2e:		build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make setup-conductor
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-debug:		build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
	make stop-lair
	make setup-conductor
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/
test-e2e-debug2:	build DNAs dist/holo_hosting_chaperone.js
	make stop-conductor
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


# Manage Holochain Conductor config
HC_LOCAL_STORAGE	= $(shell pwd)/holochain-conductor/storage

.PHONY:		start-hcc-%
conductor.log:
	touch $@

dist/holo_hosting_chaperone.js:
	ln -s node_modules/@holo-host/chaperone/dist dist

check-conductor:	check-holochain
check-holochain:
	ps -efH | grep holochain | grep -E "conductor-[0-9]+.toml"

keystore-%.key:
	@echo "Creating Holochain key for Agent $*: keystore-$*.key";
	echo $$( hc keygen --nullpass --quiet --path ./keystore-$*.key)			\
		| while read key _; do							\
			echo $$key > AGENTID;						\
		done
	@echo "Agent ID: $$(cat AGENTID)";

# TMP targets
use-local-chaperone:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev ../chaperone
use-yarn-chaperone:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev @holo-host/chaperone
use-yarn-chaperone-%:
	yarn uninstall --save @holo-host/chaperone; yarn install --save-dev @holo-host/chaperone@$*
