PG_URI=postgres://postgres:@localhost:5432/postgres

set -e

docker compose -f dev.docker-compose.yaml up -d --wait
echo "boot docker container"

psql "$PG_URI" -f node_modules/@haathie/pgmb/sql/pgmb.sql -1
echo "installed pgmb"

psql "$PG_URI" -f packages/fancy-subscriptions/sql/fancy-subscriptions.sql -1
echo "installed fancy-subscriptions"

psql "$PG_URI" -f packages/contacts-example/sql/contacts.sql -1
psql "$PG_URI" -f packages/contacts-example/sql/contacts-sub.sql -1
echo "setup contacts example"

