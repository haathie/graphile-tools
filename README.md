# Postgraphile Tooling

This repository contains a set of plugins and tools for Postgraphile, to help going to production faster.

TODOs:
- bulk mutation plugin w nested relations ✅
- advanced filtering plugin ✅
- required limit plugin ✅
- subscriptions ✅
- rate limits ✅

## Setup

1. Install deps: `npm i`
2. Bootstrap the dev environment:
	```sh
	sh scripts/bootstrap-dev.sh
	```
	Ensure you have `Docker`, `psql` installed. This will start a Postgres container, tools for managing subscriptions, and the example `contacts` database.
3. Start the contacts example server:
	```sh
	npm run dev
	```