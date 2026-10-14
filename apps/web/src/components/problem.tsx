export const Problem = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );
