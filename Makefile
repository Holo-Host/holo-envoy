SHELL		= bash

package-lock.json: package.json
	npm install
	touch $@
node_modules: package-lock.json
	npm install

build/index.js:		src/*.ts
	npm run build
docs/index.html:	build/index.js
	npx jsdoc --verbose -c ./docs/.jsdoc.json --private --destination ./docs build/index.js


.PRECIOUS:	keystore-%.key
.PHONY:		src build docs docs-watch build-watch

build:			node_modules build/index.js
docs:			node_modules docs/index.html

MOCHA_OPTS		= 

test:			build DNAs conductor-1.toml start-sim2h
	make test-unit;
	make reset-hcc; make test-integration
	make reset-hcc; make test-e2e
test-nix:		build DNAs conductor-1.toml start-sim2h
	make test-unit;
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly make reset-hcc; make test-integration
test-debug:		build DNAs conductor-1.toml start-sim2h
	CONDUCTOR_LOGS=error,warn LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/unit/
	make reset-hcc; make test-integration-debug
	make reset-hcc; make test-e2e-debug2

test-unit:		build
	npx mocha $(MOCHA_OPTS) ./tests/unit/
test-unit-debug:	build
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/unit/

test-integration:	build DNAs conductor-1.toml start-sim2h
	npx mocha $(MOCHA_OPTS) ./tests/integration/
test-integration-debug:	build DNAs conductor-1.toml start-sim2h
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn npx mocha $(MOCHA_OPTS) ./tests/integration/

test-e2e:		build DNAs conductor-1.toml start-sim2h dist/holo_hosting_chaperone.js
	npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-debug:		build DNAs conductor-1.toml start-sim2h dist/holo_hosting_chaperone.js
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/e2e/
test-e2e-debug2:	build DNAs conductor-1.toml start-sim2h dist/holo_hosting_chaperone.js
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


# Generate Conductor TOML config
HCC_DIR		= ./holochain-conductor
HCC_STORAGE	= $(shell pwd)/holochain-conductor/storage

.PHONY:		start-hcc-%
conductor.log:
	touch $@

reset-hcc:
	rm $(HCC_STORAGE)/* -rf
	rm -f dnas/*
	rm -f conductor-*.toml
start-hcc-%:		DNAs conductor-%.toml conductor.log
	holochain -c conductor-$*.toml > conductor.log 2>&1 & tail -f conductor.log

dist/holo_hosting_chaperone.js:
	ln -s node_modules/@holo-host/chaperone/dist dist

DNAs:			dnas/happ-store.dna.json dnas/holo-hosting-app.dna.json dnas/holofuel.dna.json dnas/servicelogger.dna.json
rm-DNAs:
	rm dnas/*.json
update-DNAs:		rm-DNAs DNAs

dnas/%.dna.json:
	@mkdir -p ./dnas
	@for p in $$buildInputs; do \
	    if [[ "$${p#*-}" == "$*" ]]; then \
		echo "Linking $${p} to $@"; \
		ln -fs $${p}/$*.dna.json $@; \
	    fi \
	done

check-sim2h:
	ps -efH | grep sim2h_server | grep 9000 | grep -v grep
restart-sim2h:		stop-sim2h start-sim2h
start-sim2h:
	@if [[ $$(ps -efH | grep sim2h_server | grep 9000 | grep -v grep) ]]; then	\
		echo "sim2h is already running on port 9000";				\
	else										\
		echo "Starting sim2h_server on port 9000";				\
		sim2h_server -p 9000 > sim2h.log 2>&1 &					\
	fi
stop-sim2h:
	@if [[ $$(ps -efH | grep sim2h_server | grep 9000 | grep -v grep) ]]; then	\
		echo "Stopping sim2h_server...";					\
		killall sim2h_server || true;						\
	else										\
		echo "sim2h is not running on port 9000";				\
	fi

check-conductor:	check-holochain
check-holochain:
	ps -efH | grep holochain | grep -E "conductor-[0-9]+.toml"
stop-conductor:		stop-holochain
stop-holochain:
	@if [[ $$(ps -efH | grep holochain | grep -E "conductor-[0-9]+.toml") ]]; then	\
		echo "Stopping holochain conductor...";					\
		killall holochain || true;						\
	else										\
		echo "holochain conductor is not running";				\
	fi

conductor-%.toml:	keystore-%.key $(HCC_DIR)/conductor.master.toml Makefile
	@echo "Creating Holochain conductor config for Agent $*...";			\
	AGENT=$*;									\
	PUBKEY=$$(cat AGENTID);								\
	KEYFILE=$<;									\
	S2HURI=ws://localhost:9000;							\
	WORMHOLE=http://localhost:9676;							\
	HCC_STORAGE=$(HCC_STORAGE);							\
	sed -e "s|AGENT|$$AGENT|g"							\
	    -e "s/PUBKEY/$$PUBKEY/g"							\
	    -e "s/KEYFILE/$$KEYFILE/g"							\
	    -e "s|S2HURI|$$S2HURI|g"							\
	    -e "s|WORMHOLE|$$WORMHOLE|g"						\
	    -e "s|HCC_STORAGE|$$HCC_STORAGE|g"						\
	    < $(HCC_DIR)/conductor.master.toml						\
	    > $@;									\
	echo " ... Wrote new $@ (from $(HCC_DIR)/conductor.master.toml and $<)"

keystore-%.key:
	@echo "Creating Holochain key for Agent $*: keystore-$*.key";
	echo $$( hc keygen --nullpass --quiet --path ./keystore-$*.key)			\
		| while read key _; do							\
			echo $$key > AGENTID;						\
		done
	@echo "Agent ID: $$(cat AGENTID)";

# TMP targets

use-local-chaperone:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev ../chaperone
use-npm-chaperone:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev @holo-host/chaperone
use-npm-chaperone-%:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev @holo-host/chaperone@$*
