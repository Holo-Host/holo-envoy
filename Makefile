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

build: node_modules build/index.js
docs: node_modules docs/index.html

# nix-test, nix-install, ...
nix-%:
	nix-shell --run "make $*"

.PHONY: DNAs

DNAs: dnas/holo-hosting-app.happ dnas/servicelogger.happ dnas/elemental-chat.happ dnas/test.happ

dnas:
	mkdir -p ./dnas
dnas/elemental-chat.happ: dnas
	curl -LJ 'https://github.com/holochain/elemental-chat/releases/download/v0.2.1-alpha3/elemental-chat.happ' -o $@
dnas/test.happ:	dnas
	curl -LJ 'https://github.com/Holo-Host/dummy-dna/releases/download/v0.4.2/test.happ' -o $@
dnas/holo-hosting-app.happ:	dnas
	curl 'https://holo-host.github.io/holo-hosting-app-rsm/releases/downloads/v0.1.1-alpha5/core-app.skip-proof.happ' -o $@
dnas/servicelogger.happ: dnas
# servicelogger v0.1.0-alpha11 never requires membrane proofs. If in the future it does require them, make sure to use a download that has `skip_proof: true`
	curl 'https://holo-host.github.io/servicelogger-rsm/releases/downloads/0_1_0_alpha13/servicelogger.0_1_0_alpha13.happ' -o $@



MOCHA_OPTS		= --timeout 10000 --exit

test: build
	make test-unit;
	make test-e2e;

test-debug: build
	make test-unit-debug;
	make test-e2e-debug2

test-unit: build
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/unit/
test-unit-debug:
	LOG_LEVEL=silly make test-unit

test-e2e: build DNAs dist/holo_hosting_chaperone.js
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e
test-e2e-%: build DNAs dist/holo_hosting_chaperone.js
	NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/test_$*.js
test-e2e-debug: build DNAs dist/holo_hosting_chaperone.js
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e

test-e2e-debug-%: build DNAs dist/holo_hosting_chaperone.js
	LOG_LEVEL=silly NODE_ENV=test npx mocha $(MOCHA_OPTS) ./tests/e2e/test_$*.js
test-e2e-debug2: build DNAs dist/holo_hosting_chaperone.js
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
# make update

update:
	echo '⚙️  Updating holochainVersionId in nix...'
	sed -i -e 's/^  holonixRevision = .*/  holonixRevision = $(shell jq .holonix_rev ./version-manager.json);/' config.nix;\
	sed -i -e 's/^  holochainVersionId = .*/  holochainVersionId = $(shell jq .holochain_rev ./version-manager.json);/' config.nix;\
	echo '⚙️  Building...'
	make nix-build
	echo '⚙️  Running tests...'
	make nix-test
	