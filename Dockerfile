# A single static binary on an empty filesystem.
#
# Pure-Go SQLite is what makes CGO_ENABLED=0 work, and CGO_ENABLED=0 is what
# makes `scratch` possible. There is no shell in the result, no package manager
# and nothing to update, so the attack surface of the image is the binary.
#
# That is also why `basalt health` exists: a HEALTHCHECK needs something to run,
# and adding curl would mean adding a base image and undoing all of the above.

# Must match the go directive in go/go.mod, and a test in cmd/basalt asserts it
# does. A builder older than the module needs is a build that fails only once
# somebody tries to make an image, which is later than it should be found.
ARG GO_VERSION=1.27
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src

# Dependencies first, so a change to the source does not re-download them.
COPY go/go.mod go/go.sum ./
RUN go mod download

COPY go/ ./
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /basalt ./cmd/basalt

# An empty data directory, owned by the user the server runs as. Docker
# initialises a fresh named volume from whatever the image has at the mount
# point, ownership included, and without this the volume arrives owned by root
# and the unprivileged server cannot write its lock file. Found by running it.
RUN mkdir -p /data && chown 65532:65532 /data

FROM scratch
COPY --from=build /basalt /basalt
COPY --from=build --chown=65532:65532 /data /data

# The data directory, and the reason it is named here rather than left to the
# default: the default is under $HOME, and a scratch image has no home and no
# passwd file to find one in.
ENV BASALT_DATA=/data
VOLUME /data

# Unprivileged, by number, because there is no /etc/passwd to hold a name.
#
# A named volume inherits /data's ownership from the image above, so it works
# with nothing else done. A bind mount does not: the host directory's ownership
# wins, and it has to be chowned to 65532 first. docs/running.md says so.
USER 65532:65532

EXPOSE 3003

# Bound to every interface inside the container, which is the only way the
# published port reaches it. What the container is reachable from is the
# publish rule and whatever is in front, not this.
ENTRYPOINT ["/basalt"]
CMD ["serve", "-addr", "0.0.0.0:3003"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/basalt", "health", "-addr", "127.0.0.1:3003"]

# SIGTERM is what serve listens for, and it finishes what it is doing: an ack
# means stored, and a container stopping must not turn one into a lie.
STOPSIGNAL SIGTERM
