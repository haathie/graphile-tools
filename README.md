# Postgraphile Tooling

TODOs:
- bulk mutation plugin w nested relations ✅
- advanced filtering plugin ✅
- required limit plugin ✅
- subscriptions ✅
- rate limits 

## Setup

1. Install deps: `npm i`
2. Bootstrap the dev environment:
	```sh
	sh scripts/bootstrap-dev.sh
	```
	Ensure you have `Docker`, `psql` installed. This will start a Postgres container, install `pgmb`, tools for managing LDS subscriptions, and the example `contacts` database.