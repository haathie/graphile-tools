PG_URI=postgres://postgres:@localhost:5432/postgres

set -e

docker compose -f dev.docker-compose.yaml up -d --wait
echo "boot docker container"

psql "$PG_URI" -f packages/realtime/sql/postg_realtime.sql -1
echo "installed realtime SQL"

psql "$PG_URI" -f packages/contacts-example/sql/contacts.sql -1
psql "$PG_URI" -f packages/contacts-example/sql/contacts-sub.sql -1
echo "setup contacts example"

