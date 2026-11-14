// B1: lets node unit tests render src/kit (which imports .svg logos and .css) with react-dom/server. Vite turns an .svg import into
// its URL and a .css import into a side effect; here an .svg becomes "/<name>.svg" and a .css import becomes nothing.
// Import this module first, then load the kit with a dynamic import (static imports are resolved before this runs).
import { register } from "node:module";

const hooks = `
export async function load(url, context, next) {
  if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  if (url.endsWith(".svg") || url.endsWith(".png")) {
    const name = url.split("/").pop();
    return { format: "module", source: "export default " + JSON.stringify("/" + name) + ";", shortCircuit: true };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
