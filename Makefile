SHELL		= bash

package-lock.json: package.json
	yarn install
	touch $@
node_modules: package-lock.json
	yarn install

build/index.js:		src/*.ts
	yarn run build
docs/index.html:	build/index.js
	npx jsdoc --verbose -c ./docs/.jsdoc.json --private --destination ./docs build/index.js


.PRECIOUS:	keystore-%.key
.PHONY:		src build docs docs-watch build-watch
kill-holochain:

dnas:
	mkdir -p ./dnas
dnas/holo-hosting-app.dna.gz:	dnas
	curl 'https://holo-host.github.io/holo-hosting-app-rsm/releases/downloads/v0.0.1-alpha7/holo-hosting-app.dna.gz' -o $@
dnas/servicelogger.dna.gz:	dnas
	curl 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/v0.0.1-alpha5/servicelogger.dna.gz' -o $@
dnas/test.dna.gz:	dnas
	curl -LJ 'https://github.com/Holo-Host/dummy-dna/releases/download/v0.0.2/test.dna.gz' -o $@

build:			node_modules build/index.js
docs:			node_modules docs/index.html
DNAs:			dnas/test.dna.gz dnas/holo-hosting-app.dna.gz dnas/servicelogger.dna.gz

MOCHA_OPTS		=

test:			build
	make test-unit;
	make test-integration;
	make test-e2e;
	yarn run stop-conductor

test-nix:		build
	make test-unit;
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly make test-integration
test-debug:		build
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/unit/
	make test-integration-debug
	make test-e2e-debug2

test-unit:		build
	npx mocha $(MOCHA_OPTS) ./tests/unit/
test-unit-debug:	build
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/unit/

conductor:
	mkdir -p ./tests/tmp
	rm -rf ./tests/tmp/*
	npx holochain-run-dna -c ./tests/app-config.yml -a 4444 -r ./tests/tmp &> holochain-conductor.log &

test-integration:	build DNAs
	yarn run stop-conductor &&	make conductor
	npx mocha $(MOCHA_OPTS) ./tests/integration/
test-integration-debug:	build DNAs
	yarn run stop-conductor &&	make conductor
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn npx mocha $(MOCHA_OPTS) ./tests/integration/

test-e2e:		build DNAs dist/holo_hosting_chaperone.js
	yarn run stop-conductor && make conductor
	npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-debug:		build DNAs dist/holo_hosting_chaperone.js
	yarn run stop-conductor &&	make conductor
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/e2e/
test-e2e-debug2:	build DNAs dist/holo_hosting_chaperone.js
	yarn run stop-conductor && make conductor
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn npx mocha $(MOCHA_OPTS) ./tests/e2e/

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
stop-conductor:
	yarn run stop-conductor

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
