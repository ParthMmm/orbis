import { isIPv6 } from "node:net";

export const FAILED_KEY_LIMIT = 20;
export const FAILED_SIGN_IN_LIMIT = 100;
const WINDOW_MS = 60_000;

interface Tally {
  count: number;
  until: number;
}

const MAPPED_V4 = /^::ffff:(?<v4>\d+\.\d+\.\d+\.\d+)$/iu;

/**
 * One counter per IPv6 /64, the block most providers hand a single customer,
 * so a guesser cannot buy a fresh counter with each of its addresses.
 */
export const clientBucket = (address: string): string => {
  if (!isIPv6(address)) {
    return address;
  }
  const mapped = MAPPED_V4.exec(address)?.groups?.v4;
  if (mapped) {
    return mapped;
  }
  const [head = "", tail = ""] = (address.split("%")[0] ?? address).split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = [
    ...headGroups,
    ...Array.from<string>({
      length: Math.max(0, 8 - headGroups.length - tailGroups.length),
    }).fill("0"),
    ...tailGroups,
  ];
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/u, ""))
    .join(":");
  return `${prefix}::/64`;
};

export const makeAttemptLimiter = (now: () => number = Date.now) => {
  const clients = new Map<string, Tally>();
  let group: Tally = { count: 0, until: 0 };
  const over = (tally: Tally | undefined, limit: number): boolean =>
    tally !== undefined && tally.until > now() && tally.count > limit;
  const bump = (tally: Tally | undefined): Tally => {
    const time = now();
    const count = tally !== undefined && tally.until > time ? tally.count : 0;
    return { count: count + 1, until: time + WINDOW_MS };
  };
  const bumpBucket = (bucket: string): boolean => {
    const time = now();
    for (const [client, tally] of clients) {
      if (tally.until > time) {
        break;
      }
      clients.delete(client);
    }
    const next = bump(clients.get(bucket));
    clients.delete(bucket);
    clients.set(bucket, next);
    return next.count > FAILED_KEY_LIMIT;
  };
  return {
    badKey: (address: string): boolean => bumpBucket(clientBucket(address)),
    signInAttempt: (address: string): boolean => {
      const bucket = clientBucket(address);
      if (
        over(clients.get(bucket), FAILED_KEY_LIMIT) ||
        over(group, FAILED_SIGN_IN_LIMIT)
      ) {
        return true;
      }
      group = bump(group);
      const clientOver = bumpBucket(bucket);
      return clientOver || group.count > FAILED_SIGN_IN_LIMIT;
    },
  };
};
