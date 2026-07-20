export function RouteSkeleton({ label = "Loading view" }: Readonly<{ label?: string }>) {
  return <div class="route-loading" role="status" aria-label={label}><span /><span /><span /></div>;
}
