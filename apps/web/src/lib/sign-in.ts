import type { SignInCodeSchema } from "@orbis/contracts/http-api";

import { callOrbisWithoutKey } from "@/lib/orbis";

export type IssuedSignInCode = typeof SignInCodeSchema.Type;

const browserLabel = (userAgent: string): string => {
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

export const redeemSignInCode = (apiUrl: string, code: string) =>
  callOrbisWithoutKey(apiUrl, (client) =>
    client.signIn.redeem({
      payload: { code, label: browserLabel(navigator.userAgent) },
    })
  );

export const joinGroup = (apiUrl: string, username: string, passcode: string) =>
  callOrbisWithoutKey(apiUrl, (client) =>
    client.signIn.join({
      payload: { label: browserLabel(navigator.userAgent), passcode, username },
    })
  );
