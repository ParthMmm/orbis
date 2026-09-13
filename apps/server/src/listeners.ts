import type { createApp } from "./app.js";
import type { AccessMode } from "./identity.js";

/** Explicit keys so `process.env` is narrowed to the two ports this module reads. */
interface ListenerEnvironment {
  readonly ORBIS_DEVICE_PORT?: string | undefined;
  readonly ORBIS_PORT?: string | undefined;
}

interface ListenerPorts {
  readonly devicePort?: number;
  readonly localPort: number;
}

const validatePort = (port: number, minimum: number, name: string) => {
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${name} must be an integer between ${minimum} and 65535.`);
  }
};

const validateDistinctPorts = ({ localPort, devicePort }: ListenerPorts) => {
  if (localPort !== 0 && localPort === devicePort) {
    throw new Error("Local and device ports must differ.");
  }
};

export const listenerPorts = (
  environment: ListenerEnvironment
): ListenerPorts => {
  const parse = (value: string, minimum: number, name: string): number => {
    const port = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
    validatePort(port, minimum, name);
    return port;
  };
  const localPort = parse(environment.ORBIS_PORT ?? "4310", 0, "ORBIS_PORT");
  const configured = environment.ORBIS_DEVICE_PORT;
  if (configured === undefined) {
    return { localPort };
  }
  const devicePort = parse(configured, 1, "ORBIS_DEVICE_PORT");
  validateDistinctPorts({ devicePort, localPort });
  return { devicePort, localPort };
};

/** Owns the shared app after this call, including cleanup if startup fails.
 * Direct callers may use port 0 for test allocation on either listener.
 */
export const startListeners = async (
  app: Pick<ReturnType<typeof createApp>, "handler" | "dispose">,
  ports: ListenerPorts
) => {
  const servers: Bun.Server<undefined>[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      await Promise.all(servers.map((server) => server.stop()));
      await app.dispose();
    })();
    return stopping;
  };
  const start = (port: number, mode: AccessMode) => {
    const server = Bun.serve({
      fetch: (request) => app.handler(request, mode),
      hostname: "127.0.0.1",
      maxRequestBodySize: 65_536,
      port,
    });
    servers.push(server);
    return server;
  };
  try {
    validatePort(ports.localPort, 0, "Local port");
    if (ports.devicePort !== undefined) {
      validatePort(ports.devicePort, 0, "Device port");
    }
    validateDistinctPorts(ports);
    const local = start(ports.localPort, "local");
    const device =
      ports.devicePort === undefined
        ? undefined
        : start(ports.devicePort, "device");
    return { device, local, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
