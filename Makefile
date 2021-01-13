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
CCLI_OPTS	= -p $(HC_ADMIN_PORT) #-vvvvvv

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
DNAs:			dnas/holo-hosting-app.dna.gz dnas/servicelogger.dna.gz dnas/elemental-chat.dna.gz # dnas/holofuel.dna.json
rm-DNAs:
	rm dnas/*.dna.gz
update-DNAs:		rm-DNAs DNAs
dnas:
	mkdir -p ./dnas
dnas/holo-hosting-app.dna.gz:	dnas
	curl 'https://holo-host.github.io/holo-hosting-app-rsm/releases/downloads/v0.0.1-alpha3/holo-hosting-app.dna.gz' -o $@
dnas/servicelogger.dna.gz:	dnas
	curl 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/v0.0.1-alpha3/servicelogger.dna.gz' -o $@
dnas/elemental-chat.dna.gz:	dnas
	curl 'https://github.com/holochain/elemental-chat/releases/download/v0.0.1-alpha9/elemental-chat.dna.gz' -o $@
$(AGENT):
	npx conductor-cli -q -p $(HC_ADMIN_PORT) gen-agent > $@ || rm $@
install-dnas:		$(AGENT) DNAs
	npx conductor-cli $(CCLI_OPTS) install -a "$$(cat $(AGENT))" holo-hosting-app "dnas/holo-hosting-app.dna.gz:hha"	|| true
	npx conductor-cli $(CCLI_OPTS) install -a "$$(cat $(AGENT))" servicelogger "dnas/servicelogger.dna.gz:servicelogger"	|| true
	npx conductor-cli $(CCLI_OPTS) install -a "$$(cat $(AGENT))" elemental-chat "dnas/elemental-chat.dna.gz:elementalchat"	|| true
	npx conductor-cli $(CCLI_OPTS) activate holo-hosting-app	|| true
	npx conductor-cli $(CCLI_OPTS) activate servicelogger		|| true
	npx conductor-cli $(CCLI_OPTS) activate elemental-chat		|| true
	npx conductor-cli $(CCLI_OPTS) attach-interface 44001


# TMP targets

use-local-chaperone:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev ../chaperone
use-npm-chaperone:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev @holo-host/chaperone
use-npm-chaperone-%:
	npm uninstall --save @holo-host/chaperone; npm install --save-dev @holo-host/chaperone@$*
use-local-hhdt:
	npm uninstall --save @holo-host/data-translator; npm install --save ../data-translator-js
use-npm-hhdt:
	npm uninstall --save @holo-host/data-translator; npm install --save @holo-host/data-translator
use-local-ccli:
	npm uninstall --save @holo-host/holo-cli; npm install --save-dev ../holo-cli
use-npm-ccli:
	npm uninstall --save @holo-host/holo-cli; npm install --save-dev @holo-host/holo-cli
use-local-lair-client:
	npm uninstall --save @holochain/lair-client; npm install --save-dev ../lair-client-js
use-npm-lair-client:
	npm uninstall --save @holochain/lair-client; npm install --save-dev @holochain/lair-client


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
