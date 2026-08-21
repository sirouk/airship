import type { Attributes, ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

export function useDeferredComponent<Props>(load: () => Promise<ComponentType<Props>>) {
  const [Component, setComponent] = useState<ComponentType<Props>>();
  useEffect(() => {
    void load().then((loaded) => setComponent(() => loaded), () => undefined);
  }, []);
  return Component;
}

export function createDeferredComponent<Props>(load: () => Promise<ComponentType<Props>>) {
  return (props: Props) => {
    const Component = useDeferredComponent(load);
    return Component ? <Component {...props as Props & Attributes} /> : null;
  };
}
