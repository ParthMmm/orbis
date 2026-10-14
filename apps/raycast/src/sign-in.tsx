import { Action, ActionPanel, Form, popToRoot, Toast } from "@raycast/api";
import { useState } from "react";

import { signIn, startToast } from "./orbis-client";

interface SignInValues {
  readonly code: string;
}

/**
 * Takes a Sign-in Code that Orbis Settings shows on a device already signed in, and keeps
 * the key it returns, so the capture commands need no pasted token.
 */
export default function SignIn() {
  const [isLoading, setIsLoading] = useState(false);

  const submit = async ({ code }: SignInValues) => {
    setIsLoading(true);
    const toast = await startToast("Signing in…");
    const result = await signIn(code);
    setIsLoading(false);
    if (result.kind === "failed") {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't sign in";
      toast.message = result.message;
      return;
    }
    toast.style = Toast.Style.Success;
    toast.title = `Signed in as ${result.username}`;
    toast.message = "Save Current Tab and Save Clipboard are ready.";
    await popToRoot();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={submit} title="Sign In" />
        </ActionPanel>
      }
      isLoading={isLoading}
    >
      <Form.Description text="In Orbis on a device you already use, open Settings and show a Sign-in Code. It works once and expires after 10 minutes." />
      <Form.TextField id="code" placeholder="ABCD-EFGH" title="Sign-in Code" />
    </Form>
  );
}
