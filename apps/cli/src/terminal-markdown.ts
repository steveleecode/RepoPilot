import { stripVTControlCharacters } from "node:util";

/** Line-buffered Markdown keeps tokens split across network chunks together. */
export function createTerminalMarkdown(write: (text: string) => void, color: boolean) {
  let pending = "";
  let fence: string | undefined;
  const style = (text: string, code: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const inline = (text: string): string =>
    text.replace(
      /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*/g,
      (
        _match,
        code: string | undefined,
        bold: string | undefined,
        underlineBold: string | undefined,
        strike: string | undefined,
        label: string | undefined,
        url: string | undefined,
        italic: string | undefined
      ) => {
        if (code !== undefined) return style(code, "36");
        if (bold !== undefined || underlineBold !== undefined)
          return style(bold ?? underlineBold ?? "", "1");
        if (strike !== undefined) return style(strike, "9");
        if (label !== undefined) return `${style(label, "4")} (${url ?? ""})`;
        return style(italic ?? "", "3");
      }
    );
  const line = (raw: string, newline: boolean) => {
    // Provider output must not be able to inject terminal escape sequences.
    // eslint-disable-next-line no-control-regex -- Remove complete OSC sequences before general ANSI stripping.
    const safe = raw.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "");
    const text = Array.from(stripVTControlCharacters(safe))
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || (code >= 32 && (code < 127 || code > 159));
      })
      .join("");
    const marker = text.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    let rendered: string;
    if (fence) {
      if (
        marker?.[1] &&
        marker[1]?.[0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      ) {
        fence = undefined;
        rendered = "";
      } else rendered = style(`  ${text}`, "36");
    } else if (marker) {
      fence = marker[1];
      rendered = style(`  ${marker[2]?.trim() || "code"}`, "2");
    } else if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(text)) {
      rendered = style("────────────────────────────────", "2");
    } else {
      const heading = text.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
      if (heading) rendered = style(inline(heading[1] ?? ""), "1;36");
      else rendered = inline(text.replace(/^(\s*)[-+*]\s+/, "$1• ").replace(/^(\s*)>\s?/, "$1│ "));
    }
    write(rendered + (newline ? "\n" : ""));
  };
  return {
    write(text: string) {
      pending += text;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, index).replace(/\r$/, ""), true);
        pending = pending.slice(index + 1);
      }
    },
    flush() {
      if (pending) line(pending, false);
      pending = "";
    }
  };
}
