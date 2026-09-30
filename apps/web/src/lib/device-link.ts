import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";

/**
 * Device Links (ADR 0016): a new device shows a code, and a signed-in device
 * approves it. The API compares codes without case or separators.
 */

/** Shows `ABCDEFGH` as `ABCD-EFGH`, which is easier to read aloud and type. */
export const formatUserCode = (code: string): string =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/**
 * The address a phone scans to approve this device. The code sits in the fragment,
 * so no server or log sees it. In production the origin is https://orbis.p11a.xyz.
 */
export const approvalUrl = (origin: string, code: string): string =>
  `${origin}/link#${formatUserCode(code)}`;

/** A default name for this browser, which the Person may change before starting. */
export const browserLabel = (userAgent: string): string => {
  const browser =
    [
      ["Edg/", "Edge"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
    ].find(([marker]) => userAgent.includes(marker ?? ""))?.[1] ?? "Browser";
  const system =
    [
      ["iPhone", "iPhone"],
      ["iPad", "iPad"],
      ["Android", "Android"],
      ["Mac OS X", "Mac"],
      ["Windows", "Windows"],
      ["Linux", "Linux"],
    ].find(([marker]) => userAgent.includes(marker ?? ""))?.[1] ?? null;
  return system === null ? browser : `${browser} on ${system}`;
};

/** What the page says when the API refuses a code, by response status. */
const LINK_PROBLEMS = new Map([
  [404, "No device is waiting with that code. Check it and try again."],
  [409, "That code is already approved."],
  [410, "That code has expired. Start again on the new device."],
  [429, "Too many attempts. Wait a minute and try again."],
]);

export const linkProblem = (
  result: Extract<ApiResult<unknown>, { ok: false }>
): string =>
  LINK_PROBLEMS.get(result.status ?? 0) ?? FAILURE_MESSAGES[result.failure];
