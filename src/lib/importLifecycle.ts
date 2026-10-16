// The import promise and its Files survive React route changes. Browser closure
// before the server confirms durable copies still needs an explicit warning.
let imports = 0;
const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
export async function importPhotos(url: string, init: RequestInit): Promise<Response> {
  imports += 1;
  if (imports === 1) window.addEventListener("beforeunload", guard);
  try { return await fetch(url, init); }
  finally {
    imports -= 1;
    if (!imports) window.removeEventListener("beforeunload", guard);
  }
}
