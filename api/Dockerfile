FROM node:22-alpine

ARG VERSION=dev
ARG VCS_REF=dev
ARG BUILD_DATE=unknown

LABEL maintainer="Duarte Santos https://gitlab.com/DuarteSantos8" \
    org.opencontainers.image.title="opengym-api" \
    org.opencontainers.image.description="Backend for Self-hosted gym & body-weight tracker — plan routines, log workouts (supersets & cardio too), track your weight and progress, passkey login. Your data, your server." \
    org.opencontainers.image.source="https://gitlab.com/DuarteSantos8/opengym" \
    org.opencontainers.image.url="https://gitlab.com/DuarteSantos8/opengym/container_registry" \
    org.opencontainers.image.documentation="https://gitlab.com/DuarteSantos8/opengym#readme" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$VCS_REF \
    org.opencontainers.image.created=$BUILD_DATE

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
# Copy every module and then drop the tests, rather than listing the runtime files by hand.
# The hand-written list was here first, with a comment warning that a module left off it would
# pass every test and then crash-loop the container — because the tests import from the working
# tree, where the file exists. It happened anyway, twice: link.js, then strava.js. A comment
# asking to remember something is not a mechanism; this is. Tests are excluded because they pull
# in devDependencies that `npm install --omit=dev` never installed.
COPY *.js ./
RUN rm -f *.test.js

ENV NODE_ENV=production
ENV PORT=3000
# The image has no .git, so the only way the running process can name the commit it was built
# from is for the build to hand it over. The ARGs above already exist for the OCI labels, but an
# ARG is build-time only — promoting them to ENV is what makes them readable from server.js
# (GET /api/health reports them). Their ARG defaults ('dev'/'unknown') are placeholders for
# "nobody passed one" and server.js rejects anything that isn't a real commit hash, so an
# un-parameterised `docker build` reports no version rather than a fake one.
ENV VCS_REF=$VCS_REF
ENV BUILD_DATE=$BUILD_DATE

EXPOSE 3000
CMD ["node", "server.js"]

HEALTHCHECK --interval=5m \
            --timeout=5s \
            --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${PORT}/api/health" || exit 1
