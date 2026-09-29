import { Context } from "effect";

export class SetCaller extends Context.Service<
  SetCaller,
  | { readonly kind: "local" }
  | { readonly kind: "device"; readonly deviceId: string }
>()("Orbis/SetCaller") {}
