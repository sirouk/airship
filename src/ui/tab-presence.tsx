import { useEffect, useRef, useState } from "preact/hooks";

const CHANNEL = "airship-page-presence-v1";

export function TabPresenceNote() {
  const id = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  const [peer, setPeer] = useState(false);
  useEffect(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => {
      if (!event.data || event.data.id === id.current) return;
      if (event.data.type === "hello" || event.data.type === "present") {
        setPeer(true);
        if (event.data.type === "hello") channel.postMessage({ type: "present", id: id.current });
      }
    };
    channel.postMessage({ type: "hello", id: id.current });
    return () => channel.close();
  }, []);
  return peer ? <span class="tab-presence-note" role="status">Open in another tab · page-memory state is not shared</span> : null;
}
