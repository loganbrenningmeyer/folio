// Read the original fence text even after syntax highlighting adds spans.
export function codeFenceFromPre(node) {
  const code = node?.children?.find((child) => child.tagName === "code");
  if (!code) return undefined;
  const classes = code.properties?.className;
  const names = Array.isArray(classes) ? classes : String(classes ?? "").split(/\s+/);
  const language = names.find((name) => String(name).startsWith("language-"));
  if (!language) return undefined;
  function text(child) {
    return typeof child.value === "string"
      ? child.value
      : (child.children ?? []).map(text).join("");
  }
  return {
    language: String(language).slice("language-".length),
    code: text(code).replace(/\n$/, ""),
    meta: typeof code.data?.meta === "string" ? code.data.meta : "",
  };
}
