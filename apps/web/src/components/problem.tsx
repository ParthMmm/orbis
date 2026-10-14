/** Why the last action failed, announced to screen readers. Renders nothing without one. */
export const Problem = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );
