set -e
ENV_TYPE=${NODE_ENV:-development}
ENV_FILE=.env.${ENV_TYPE}

node --experimental-strip-types --env-file $ENV_FILE $@