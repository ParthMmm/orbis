export const formField = (form: FormData, name: string): string =>
  String(form.get(name) ?? "").trim();
