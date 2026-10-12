import { formatSignInCode } from "@orbis/contracts";

import type { IssuedSignInCode } from "@/lib/sign-in";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A Sign-in Code, large enough to read from across a table. */
export const SignInCode = ({
  issued,
  label,
}: {
  readonly issued: IssuedSignInCode;
  readonly label: string;
}) => (
  <div className="bg-muted flex flex-col items-center gap-1 rounded-2xl p-4">
    <output
      aria-label={label}
      className="font-mono text-3xl font-medium tracking-widest"
    >
      {formatSignInCode(issued.code)}
    </output>
    <p className="text-muted-foreground text-sm">
      Works once, until {timeFormat.format(new Date(issued.expiresAt))}.
    </p>
  </div>
);
