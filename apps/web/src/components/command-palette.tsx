"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "@repopilot/ui";

const actions = [
  { label: "Analyze repository", status: "planned" },
  { label: "Generate configuration", status: "planned" },
  { label: "Run validators", status: "planned" }
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-500 shadow-sm outline-none transition hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-950 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:focus-visible:ring-neutral-100"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">Command palette</span>
        <kbd className="ml-auto hidden rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 dark:border-neutral-700 md:inline">
          ⌘K
        </kbd>
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/25 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="command-palette-title"
        >
          <div className="mx-auto mt-16 max-w-xl rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex items-center gap-3 border-b border-neutral-200 p-3 dark:border-neutral-800">
              <Search className="size-4 text-neutral-400" aria-hidden="true" />
              <h2 id="command-palette-title" className="sr-only">
                Command palette
              </h2>
              <input
                autoFocus
                placeholder="Commands are planned for a future milestone"
                className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
              />
              <IconButton aria-label="Close command palette" onClick={() => setOpen(false)}>
                <X className="size-4" aria-hidden="true" />
              </IconButton>
            </div>
            <div className="p-2">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  disabled
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-neutral-500 disabled:cursor-not-allowed"
                >
                  <span>{action.label}</span>
                  <span className="text-xs uppercase tracking-normal">{action.status}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
