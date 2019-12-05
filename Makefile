
build/index.js:		src/*.ts
	npm run build
docs/index.html:	build/index.js
	npx jsdoc --verbose -c ./docs/.jsdoc.json --private --destination ./docs build/index.js


.PHONY:		src build docs docs-watch build-watch

build:			build/index.js
docs:			docs/index.html

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
