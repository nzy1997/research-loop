.DEFAULT_GOAL := dev

# Every target delegates to a package script, which delegates to the CLI in
# scripts/, which calls the public interfaces of lib/. The Makefile is the
# stable human- and agent-facing surface; it holds no knowledge-system logic of
# its own, so a rule can never disagree with the code it fronts.
#
# QUERY, FILE, and KEY are refused when empty rather than passed through as an
# empty string: exit 2 means "the invocation was wrong", the same code
# scripts/draft-preview.ts uses for that failure.

.PHONY: help dev build test pages-build \
	knowledge-check knowledge-resolve knowledge-preview \
	draft-preview drafts-preview \
	literature-index literature-fetch literature-sync \
	migration-verify \
	problem-import-autoqec-css-distance problem-import-verify \
	problem-index problem-publish \
	autoresearch-service \
	zotero-plugin-test zotero-plugin

help:
	@echo 'Research Loop'
	@echo
	@echo '  make dev                                        install if needed, then serve the problem console locally'
	@echo '  make build                                      index problems/, render knowledge/ into public/knowledge/, then build the app'
	@echo '  make test                                       lint, both unit suites, pages showcase, rendered-output tests, browser tests'
	@echo '  make pages-build                                snapshot the static Prob-000 example into out/ for GitHub Pages'
	@echo
	@echo '  make knowledge-check                            validate the trusted knowledge tree'
	@echo '  make knowledge-resolve QUERY="triangular TFIM"  print the reading bundle for one research question'
	@echo '  make knowledge-preview                          serve the trusted knowledge site locally'
	@echo
	@echo '  make draft-preview FILE=drafts/path.md          render one untrusted draft note locally'
	@echo '  make drafts-preview                             preview the untrusted drafts workspace locally'
	@echo
	@echo '  make literature-index                           regenerate every literature/<method>/INDEX.md'
	@echo '  make literature-fetch KEY=citekey               fetch the pinned arXiv source of one reference'
	@echo '  make literature-sync                            fetch the pinned source of every arXiv reference'
	@echo
	@echo '  make migration-verify                           re-check the imported harness cards against the manifest'
	@echo '  make problem-import-autoqec-css-distance SOURCE=/Users/nzy/AutoQEC  import the 200-trial AutoQEC CSS-distance record as Prob-001'
	@echo '  make problem-import-verify ID=Prob-001                         verify a committed imported problem without reading AutoQEC'
	@echo '  make problem-index                                              refresh the generated problem index'
	@echo '  make problem-publish STAGE=".generated/problem-staging/<run>/Prob-NNN" ID=Prob-NNN  publish one validated staged draft'
	@echo '  make autoresearch-service                       serve local-only autoresearch preparation diagnostics'
	@echo '  make zotero-plugin-test                         type-check and test the Zotero integration'
	@echo '  make zotero-plugin                              test and build the installable Zotero XPI'

dev: node_modules/.package-lock.json
	npm run dev

build: node_modules/.package-lock.json
	npm run build

test: node_modules/.package-lock.json
	npm test

# The GitHub Pages showcase snapshots `dist/`, so it needs a build first.
pages-build: build
	npm run pages:build

knowledge-check: node_modules/.package-lock.json
	npm run knowledge:check

# Silent, and with the recipe unechoed: stdout is one JSON document that a
# caller may pipe straight into a parser.
knowledge-resolve: node_modules/.package-lock.json
	@if [ -z "$(QUERY)" ]; then \
		echo 'usage: make knowledge-resolve QUERY="<the research question>"' >&2; \
		exit 2; \
	fi
	@npm run --silent knowledge:resolve -- --query "$(QUERY)"

knowledge-preview: node_modules/.package-lock.json
	npm run knowledge:preview

draft-preview: node_modules/.package-lock.json
	@if [ -z "$(FILE)" ]; then \
		echo 'usage: make draft-preview FILE=drafts/<note>.md' >&2; \
		exit 2; \
	fi
	npm run draft:preview -- --file "$(FILE)"

drafts-preview: node_modules/.package-lock.json
	quarto preview drafts --no-execute

literature-index: node_modules/.package-lock.json
	npm run literature:index

literature-fetch: node_modules/.package-lock.json
	@if [ -z "$(KEY)" ]; then \
		echo 'usage: make literature-fetch KEY=<citekey>' >&2; \
		exit 2; \
	fi
	npm run literature:fetch -- --key "$(KEY)"

literature-sync: node_modules/.package-lock.json
	npm run literature:sync

zotero-plugin-test: integrations/zotero/node_modules/.package-lock.json
	cd integrations/zotero && npm run check && npm test

zotero-plugin: zotero-plugin-test
	cd integrations/zotero && npm run build

integrations/zotero/node_modules/.package-lock.json: integrations/zotero/package-lock.json
	cd integrations/zotero && npm ci

problem-import-autoqec-css-distance: node_modules/.package-lock.json
	@if [ -z "$(SOURCE)" ]; then \
		echo 'usage: make problem-import-autoqec-css-distance SOURCE=/Users/nzy/AutoQEC' >&2; \
		exit 2; \
	fi
	npm run problem:import:autoqec-css-distance -- --source "$(SOURCE)"

problem-import-verify: node_modules/.package-lock.json
	npm run problem:import:verify -- --id "$(or $(ID),Prob-001)"

problem-index: node_modules/.package-lock.json
	@npm run --silent problem:index

problem-publish: node_modules/.package-lock.json
	@if [ -z "$(STAGE)" ] || [ -z "$(ID)" ]; then \
		echo 'usage: make problem-publish STAGE=".generated/problem-staging/<run>/Prob-NNN" ID=Prob-NNN' >&2; \
		exit 2; \
	fi
	@npm run --silent problem:publish -- --stage "$(STAGE)" --id "$(ID)"

autoresearch-service: node_modules/.package-lock.json
	npm run autoresearch:service

node_modules/.package-lock.json: package-lock.json
	npm ci
