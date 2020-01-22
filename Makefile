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


.PHONY:		src build docs docs-watch build-watch

build:			node_modules build/index.js
docs:			node_modules docs/index.html

MOCHA_OPTS		= 

test:			build
	npx mocha $(MOCHA_OPTS) --recursive ./tests/*/
test-debug:		build
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) --recursive ./tests
test-unit:		build
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/unit/
test-integration:	build
	LOG_LEVEL=silly npx mocha $(MOCHA_OPTS) ./tests/integration/

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
HCC_STORAGE	= /var/lib/holochain-conductor

.PHONY:		start-hcc-%
start-hcc-%:		DNAs conductor-%.toml
	holochain -c conductor-$*.toml

DNAs:			dist/happ-store.dna.json dist/holo-hosting-app.dna.json dist/holofuel.dna.json dist/servicelogger.dna.json
dist/%.dna.json:
	@for p in $$buildInputs; do \
	    echo "Checking derivation $$p ($${p#*-} == $*)"; \
	    if [[ "$${p#*-}" == "$*" ]]; then \
		echo "Linking $${p} to $@"; \
		ln -fs $${p}/$*.dna.json $@; \
	    fi \
	done

conductor-%.toml:	keystore-%.key $(HCC_DIR)/conductor.master.toml Makefile
	@echo "Creating Holochain conductor config for Agent $*...";			\
	AGENT=$*;									\
	PUBKEY=$$( ls -l $< ); PUBKEY=$${PUBKEY##*/};					\
	KEYFILE=$<;									\
	S2HURI=wss://sim2h.holochain.org:9000;						\
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
	@echo -n "Creating Holochain key for Agent $*...";				\
	eval $$( hc keygen --nullpass --quiet						\
	  | python -c "import sys;						\
	      print('\n'.join('%s=%s' % ( k, v.strip() )			\
		for (k, v) in zip(['KEY','KEYFILE'], sys.stdin.readlines())))"	\
	);										\
	echo " $@ -> $$KEYFILE";							\
	ln -fs $$KEYFILE $@
