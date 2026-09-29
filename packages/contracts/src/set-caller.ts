import { Context } from "effect";

export class SetCaller extends Context.Service<
  SetCaller,
  {
    readonly kind: "accepted";
    readonly keyId: string | null;
    readonly person: {
      readonly id: string;
      readonly removed: boolean;
      readonly username: string;
    };
    readonly scope: "daily" | "admin";
  }
>()("Orbis/SetCaller") {}
