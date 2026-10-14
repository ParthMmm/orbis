/** A text field's trimmed value, or "" when the form has no such field. */
export const formField = (form: FormData, name: string): string =>
  String(form.get(name) ?? "").trim();
