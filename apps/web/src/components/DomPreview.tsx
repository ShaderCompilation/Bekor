import type { DomVariant } from "@bekor/contracts";
import { domFilesSchema } from "@bekor/contracts";
import type { SandboxSetup } from "@codesandbox/sandpack-client";
import type { SandpackRuntime } from "@codesandbox/sandpack-client/clients/runtime";
import { useEffect, useRef, useState } from "react";

const BUNDLER = "https://2-19-8-sandpack.codesandbox.io";
const templates = {
  vanilla: "parcel",
  react: "create-react-app",
  vue: "vue-cli",
  svelte: "svelte",
} as const;

function setup(variant: DomVariant, files: Record<string, string>): SandboxSetup {
  domFilesSchema.parse(files);
  const paths = Object.keys(variant.files);
  if (
    Object.keys(files).length !== paths.length ||
    paths.some((path) => !Object.hasOwn(files, path))
  )
    throw new Error("Preview files must match this exercise's editable files.");
  return {
    files: Object.fromEntries(Object.entries(files).map(([path, code]) => [`/${path}`, { code }])),
    entry: `/${variant.entry}`,
    dependencies: variant.dependencies,
    // Vue's SFC output needs the Babel stage enabled by the official template.
    devDependencies:
      variant.framework === "vue"
        ? {
            "@vue/cli-plugin-babel": "5.0.8",
            "@vue/cli-service": "5.0.8",
          }
        : {},
    template: templates[variant.framework],
  };
}

function prepareFrame(frame: HTMLIFrameElement) {
  frame.title = "DOM exercise preview";
  // The compiler needs its own origin. It never shares Bekor's origin or credentials.
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute(
    "allow",
    "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'",
  );
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText = "width:100%;height:420px;border:1px solid #888;background:white";
}

export default function DomPreview({
  variant,
  files,
  restart,
}: {
  variant: DomVariant;
  files: Record<string, string>;
  restart: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const clients = useRef(new Set<SandpackRuntime>());
  const latest = useRef({ variant, files });
  latest.current = { variant, files };
  const popup = useRef<Window | null>(null);
  const attach = useRef<((frame: HTMLIFrameElement) => void) | null>(null);
  const [status, setStatus] = useState("Loading preview compiler…");
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [popupMessage, setPopupMessage] = useState("");
  const [manualRestart, setManualRestart] = useState(0);

  useEffect(() => {
    let disposed = false;
    const frames = new Set<HTMLIFrameElement>();
    const closeClients = new Map<HTMLIFrameElement, () => void>();
    const disposers: (() => void)[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    setStatus("Loading preview compiler…");
    setDiagnostics([]);
    if (restart > 0 || manualRestart > 0)
      setPopupMessage("Preview restarted. Your editor draft is kept.");
    // Sandpack checks source + channel; also reject a navigated frame's foreign origin
    // before its protocol listener receives the event.
    const guard = (event: MessageEvent) => {
      if (![...frames].some((frame) => event.source === frame.contentWindow)) return;
      const data: unknown = event.data;
      if (
        event.origin !== BUNDLER ||
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        typeof data.type !== "string"
      )
        event.stopImmediatePropagation();
    };
    window.addEventListener("message", guard, true);
    const append = (text: string) =>
      setDiagnostics((old) => [...old.slice(-49), text.slice(0, 2000)]);
    const mount = async (frame: HTMLIFrameElement) => {
      frames.add(frame);
      prepareFrame(frame);
      const owner = frame.ownerDocument.defaultView;
      if (owner && owner !== window) {
        const forward = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow || event.origin !== BUNDLER) return;
          window.dispatchEvent(
            new MessageEvent("message", {
              data: event.data,
              origin: event.origin,
              source: event.source,
            }),
          );
        };
        owner.addEventListener("message", forward);
        disposers.push(() => owner.removeEventListener("message", forward));
      }
      try {
        const { SandpackRuntime: Runtime } = await import(
          "@codesandbox/sandpack-client/clients/runtime"
        );
        if (disposed || !frame.isConnected) return;
        const client = new Runtime(frame, setup(latest.current.variant, latest.current.files), {
          bundlerURL: BUNDLER,
          showOpenInCodeSandbox: false,
          showErrorScreen: true,
          showLoadingScreen: true,
          clearConsoleOnFirstCompile: true,
        });
        clients.current.add(client);
        let ready = false;
        const timeout = setTimeout(() => {
          if (!ready && !disposed)
            setStatus("Preview could not load. Check your connection and restart preview.");
        }, 45_000);
        timers.add(timeout);
        // Bound parent updates even if learner code emits a very large console stream.
        let messages = 0;
        let quotaAt = Date.now();
        const unsubscribe = client.listen((message) => {
          if (disposed) return;
          if (Date.now() - quotaAt > 1000) {
            messages = 0;
            quotaAt = Date.now();
          }
          if (++messages > 100) return;
          if (message.type === "done" || message.type === "success") {
            ready = true;
            clearTimeout(timeout);
            setStatus(
              message.type === "done" && message.compilatonError
                ? "Compilation failed. Check the diagnostics."
                : "Preview rendered. Check the requirements yourself.",
            );
          } else if (message.type === "status") {
            setStatus(
              `Preview: ${typeof message.status === "string" ? message.status.slice(0, 120) : "updating"}`,
            );
          } else if (message.type === "action" && message.action === "show-error") {
            ready = true;
            clearTimeout(timeout);
            setStatus("Preview error. Your draft is saved; fix the code or restart preview.");
            const bounded = (value: unknown) =>
              typeof value === "string"
                ? value.slice(0, 500)
                : typeof value === "number"
                  ? String(value)
                  : "";
            append(
              `${bounded(message.title)}: ${bounded(message.message)} (${bounded(message.path)}:${bounded(message.line)})`,
            );
          } else if (message.type === "console" && Array.isArray(message.log)) {
            for (const log of message.log.slice(-10)) {
              if (!log || typeof log.method !== "string" || !Array.isArray(log.data)) continue;
              if (log.method === "clear") setDiagnostics([]);
              else
                append(
                  `${log.method.slice(0, 20)}: ${log.data
                    .slice(0, 10)
                    .map((item) => (typeof item === "string" ? item.slice(0, 180) : "[object]"))
                    .join(" ")}`,
                );
            }
          }
        });
        const dispose = () => {
          if (!clients.current.has(client)) return;
          clearTimeout(timeout);
          timers.delete(timeout);
          unsubscribe();
          client.destroy();
          clients.current.delete(client);
          closeClients.delete(frame);
          frames.delete(frame);
        };
        closeClients.set(frame, dispose);
        disposers.push(dispose);
      } catch (error) {
        if (!disposed) {
          setStatus("Unable to start preview. Your draft is saved.");
          append(error instanceof Error ? error.message : "Compiler could not load.");
        }
      }
    };
    attach.current = (frame) => {
      void mount(frame);
    };
    const frame = document.createElement("iframe");
    frame.dataset.variant = variant.id;
    container.current?.replaceChildren(frame);
    void mount(frame);
    // A restart replaces both browsing contexts; this also recovers a looping preview.
    if (popup.current && !popup.current.closed) {
      const extra = popup.current.document.createElement("iframe");
      popup.current.document.body.replaceChildren(extra);
      void mount(extra);
    }
    const monitor = setInterval(() => {
      for (const [ownedFrame, dispose] of closeClients) {
        if (ownedFrame.ownerDocument.defaultView?.closed) dispose();
      }
      if (popup.current?.closed) {
        popup.current = null;
        setPopupMessage("Separate preview closed. Your editor draft is kept.");
      }
    }, 1000);
    return () => {
      disposed = true;
      attach.current = null;
      clearInterval(monitor);
      for (const timer of timers) clearTimeout(timer);
      for (const dispose of disposers) dispose();
      for (const frame of frames) frame.remove();
      window.removeEventListener("message", guard, true);
    };
  }, [variant.id, restart, manualRestart]);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const content = setup(variant, files);
        for (const client of clients.current) client.updateSandbox(content);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Invalid project files.");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [variant, files]);

  useEffect(
    () => () => {
      popup.current?.close();
      popup.current = null;
    },
    [],
  );

  function popout() {
    if (popup.current && !popup.current.closed) {
      popup.current.focus();
      return;
    }
    const opened = window.open("about:blank", "_blank", "popup,width=900,height=650");
    if (!opened) {
      setPopupMessage("Popup blocked. Allow popups for Bekor, then try again.");
      return;
    }
    popup.current = opened;
    opened.document.title = "Bekor DOM preview";
    opened.document.body.style.margin = "0";
    const frame = opened.document.createElement("iframe");
    opened.document.body.append(frame);
    attach.current?.(frame);
    setPopupMessage("Separate preview stays synchronized while this workspace is open.");
  }

  return (
    <section aria-label="Live DOM preview">
      <div className="actions">
        <button type="button" onClick={() => setManualRestart((value) => value + 1)}>
          Restart preview
        </button>
        <button type="button" onClick={popout}>
          Open preview in separate window
        </button>
      </div>
      <p role="status">{status}</p>
      {popupMessage && <p role="status">{popupMessage}</p>}
      <div ref={container} />
      <details>
        <summary>Preview console and diagnostics ({diagnostics.length}/50)</summary>
        <button type="button" onClick={() => setDiagnostics([])}>
          Clear preview console
        </button>
        <pre role="log" aria-label="Preview console">
          {diagnostics.join("\n") || "No diagnostics."}
        </pre>
      </details>
    </section>
  );
}
