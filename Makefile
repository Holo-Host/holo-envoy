SHELL		= bash

.PHONY:		src build docs docs-watch build-watch

#
# Project
#
package-lock.json: package.json
	npm install
	touch $@
node_modules: package-lock.json
	npm install

build/index.js:		src/*.ts
	npm run build
build:			node_modules build/index.js
dist/holo_hosting_chaperone.js:
	ln -s node_modules/@holo-host/chaperone/dist dist


# Documentation
CURRENT_BRANCH = $(shell git branch | grep \* | cut -d ' ' -f2)

docs/index.html:	build/index.js
	npx jsdoc --verbose -c ./docs/.jsdoc.json --private --destination ./docs build/index.js
docs:			node_modules docs/index.html
docs-watch:
build-watch:
# above targets are for autocompletion
%-watch:
	npx chokidar -d 3000 'src/**/*.ts' -c "make --no-print-directory $*" 2> /dev/null
clean-docs:
	git clean -df ./docs
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


# Lair Keystore
LAIR_DIR	= ./tests/lair
AGENT		= ./tests/AGENT
HC_DIR		= ./tests/conductor-storage
HC_CONF		= $(HC_DIR)/conductor-config.yml
HC_ADMIN_PORT	= 35678

lair:			$(LAIR_DIR)/socket
$(LAIR_DIR)/socket:
	nix-shell --run "RUST_LOG=trace lair-keystore --lair-dir $(LAIR_DIR) > lair.log 2>&1 &"
stop-lair:
	kill $$(cat $(LAIR_DIR)/pid) && rm -f $(LAIR_DIR)/pid $(LAIR_DIR)/socket $(LAIR_DIR)/store
check-lair:
	@ps -efH | grep -v grep | grep lair-keystore
	@pgrep lair-keystore


# Holochain Conductor
reset-hcc:
	rm $(HC_DIR)/databases/ -rf
conductor:		$(HC_DIR)/pid
$(HC_DIR):
	mkdir -p $(HC_DIR)
$(HC_CONF):		$(HC_DIR) tests/genconfig.js
	node tests/genconfig.js $(HC_ADMIN_PORT) $(HC_CONF)
$(HC_DIR)/pid:
	make $(HC_CONF)
	RUST_LOG=trace holochain --config-path $(HC_DIR)/conductor-config.yml > conductor.log 2>&1 & echo $$! | tee $(HC_DIR)/pid
stop-conductor:
	kill $$(cat $(HC_DIR)/pid) && rm -f $(HC_DIR)/pid && rm -rf $(HC_DIR)/databases
check-conductor:	check-holochain
check-holochain:
	@ps -efH | grep -v grep | grep -E "holochain.*config.yml"
	@pgrep holochain
conductor.log:
	touch $@
DNAs:			dnas/holo-hosting-app.dna.gz dnas/servicelogger.dna.gz # dnas/holofuel.dna.json
rm-DNAs:
	rm dnas/*.dna.gz
update-DNAs:		rm-DNAs DNAs
dnas/holo-hosting-app.dna.gz:
	@mkdir -p ./dnas
	wget -O $@ 'https://holo-host.github.io/holo-hosting-app-rsm/releases/downloads/v0.0.1-alpha3/holo-hosting-app.dna.gz'
dnas/servicelogger.dna.gz:
	@mkdir -p ./dnas
	wget -O $@ dnas/ 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/v0.0.1-alpha3/servicelogger.dna.gz'
$(AGENT):
	npx conductor-cli -q -p $(HC_ADMIN_PORT) gen-agent > $@
install-dnas:		$(AGENT)
	npx conductor-cli -vvv -p $(HC_ADMIN_PORT) install -a "$$(cat $(AGENT))" holo-hosting-app "dnas/holo-hosting-app.dna.gz:hha"
	npx conductor-cli -vvv -p $(HC_ADMIN_PORT) install -a "$$(cat $(AGENT))" servicelogger "dnas/servicelogger.dna.gz:servicelogger"
	npx conductor-cli -vvv -p $(HC_ADMIN_PORT) activate holo-hosting-app
	npx conductor-cli -vvv -p $(HC_ADMIN_PORT) activate servicelogger
	npx conductor-cli -vvv -p $(HC_ADMIN_PORT) attach-interface 44001


# TMP targets

use-local-chaperone:
	npm uninstall --save @holo-host/chaperone; yarn add --save-dev ../chaperone
use-npm-chaperone:
	npm uninstall --save @holo-host/chaperone; yarn add --save-dev @holo-host/chaperone
use-npm-chaperone-%:
	npm uninstall --save @holo-host/chaperone; yarn add --save-dev @holo-host/chaperone@$*
use-local-hhdt:
	npm uninstall --save @holo-host/data-translator; npm install --save ../data-translator-js
use-npm-hhdt:
	npm uninstall --save @holo-host/data-translator; npm install --save @holo-host/data-translator
use-local-hrd:
	npm uninstall --save @holochain-open-dev/holochain-run-dna; npm install --save-dev ../holochain-run-dna
use-npm-hrd:
	npm uninstall --save @holochain-open-dev/holochain-run-dna; npm install --save-dev @holochain-open-dev/holochain-run-dna


#
# Testing
#
MOCHA_OPTS		=
runtime:		DNAs lair conductor install-dnas
test:			build DNAs conductor-1.toml start-sim2h
	make test-unit;
	make test-integration;
	make test-e2e;
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

test-integration:	build runtime
	npx mocha $(MOCHA_OPTS) ./tests/integration/
test-integration-debug:	build runtime
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn npx mocha $(MOCHA_OPTS) ./tests/integration/

test-e2e:		build runtime dist/holo_hosting_chaperone.js
	npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-debug:		build runtime dist/holo_hosting_chaperone.js
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/e2e/
test-e2e-debug2:	build runtime dist/holo_hosting_chaperone.js
	LOG_LEVEL=silly CONDUCTOR_LOGS=error,warn npx mocha $(MOCHA_OPTS) ./tests/e2e/


#
# Repository
#
clean-remove-chaff:
	@find . -name '*~' -exec rm {} \;
clean-files:		clean-remove-chaff
	git clean -nd
clean-files-force:	clean-remove-chaff
	git clean -fd
clean-files-all:	clean-remove-chaff
	git clean -ndx
clean-files-all-force:	clean-remove-chaff
	git clean -fdx
