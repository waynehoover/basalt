/**
 * A TCP proxy that adds latency, for measuring against a wire that is not
 * loopback.
 *
 * Loopback numbers say what the software costs and nothing about what a network
 * costs, and the two are not the same shape: latency multiplies round trips,
 * bandwidth multiplies bytes, and a design can be good at one and bad at the
 * other. Sync Engine's published figures were taken over 400ms of ping, which
 * is why that number appears here.
 *
 * Delay is applied to each direction at half the round trip, so `rttMs` is the
 * round trip a client experiences. Bandwidth, when given, is applied per
 * direction as bytes per second.
 *
 * Only ever used by benchmarks and tests, so nothing it does reaches a shipped
 * bundle.
 */

import { createServer, connect, type Server, type Socket } from "node:net";

export interface Wire {
    /** Round trip time in milliseconds, split evenly between the directions. */
    readonly rttMs: number;
    /** Bytes per second in each direction, or undefined for unthrottled. */
    readonly bytesPerSecond?: number;
}

export class LatencyProxy {
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();
    port = 0;

    constructor(
        private readonly targetHost: string,
        private readonly targetPort: number,
        private readonly wire: Wire
    ) {}

    async start(): Promise<void> {
        this.server = createServer((client) => {
            const upstream = connect(this.targetPort, this.targetHost);
            this.sockets.add(client);
            this.sockets.add(upstream);

            // Each direction gets its own queue, because a delayed write must
            // not overtake one queued before it: a stream delivered out of
            // order is a different stream.
            const forward = this.delayed(upstream);
            const back = this.delayed(client);

            client.on("data", forward);
            upstream.on("data", back);

            const close = () => {
                client.destroy();
                upstream.destroy();
                this.sockets.delete(client);
                this.sockets.delete(upstream);
            };
            client.on("close", close);
            client.on("error", close);
            upstream.on("close", close);
            upstream.on("error", close);
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(0, "127.0.0.1", () => {
                const address = this.server!.address();
                this.port = typeof address === "object" && address ? address.port : 0;
                resolve();
            });
        });
    }

    /**
     * Writes to a socket after the wire's delay, in the order it arrived.
     *
     * Order is the whole difficulty. These are TCP segments, and a WebSocket
     * frame is routinely split across several of them, so a queue that lets one
     * segment overtake another does not model a slow network, it models a
     * corrupt one. An earlier version computed a delay per segment and handed
     * each to its own timer, and the frames arrived shuffled: the client
     * received a 151 byte fragment where a chunk should have been, which its
     * own check on the name caught.
     *
     * So there is one queue and one timer. A segment departs at the later of
     * when it arrived and when the previous one finished going out, plus the
     * time its own bytes take on the wire, and lands one way later. Departures
     * are therefore monotonic and so are arrivals.
     */
    private delayed(to: Socket): (chunk: Buffer) => void {
        const oneWayMs = this.wire.rttMs / 2;
        const queue: Array<{ at: number; chunk: Buffer }> = [];
        let lastDeparture = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const drain = () => {
            timer = undefined;
            const now = Date.now();
            while (queue.length > 0 && queue[0]!.at <= now) {
                const next = queue.shift()!;
                if (!to.destroyed) to.write(next.chunk);
            }
            if (queue.length > 0) {
                timer = setTimeout(drain, Math.max(1, queue[0]!.at - Date.now()));
            }
        };

        return (chunk: Buffer) => {
            const now = Date.now();
            const serialiseMs = this.wire.bytesPerSecond
                ? (chunk.length / this.wire.bytesPerSecond) * 1000
                : 0;
            const departure = Math.max(now, lastDeparture) + serialiseMs;
            lastDeparture = departure;
            queue.push({ at: departure + oneWayMs, chunk });
            if (timer === undefined) {
                timer = setTimeout(drain, Math.max(0, queue[0]!.at - Date.now()));
            }
        };
    }

    get url(): string {
        return `ws://127.0.0.1:${this.port}`;
    }

    async stop(): Promise<void> {
        for (const s of this.sockets) s.destroy();
        this.sockets.clear();
        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
        this.server = undefined;
    }
}
