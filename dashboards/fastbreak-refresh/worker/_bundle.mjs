// Builds the single-file worker.js that Cloudflare's Quick Edit accepts
// (Quick Edit cannot resolve local module imports). historic.js is inlined
// inside a namespace IIFE and the names index.js imports are destructured out.
//
//   node dashboards/fastbreak-refresh/worker/_bundle.mjs > worker-bundle.js
//
// `wrangler deploy` does NOT need this -- it bundles index.js + historic.js
// itself. This is only for pasting into the dashboard.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const historic = readFileSync(join(here, "historic.js"), "utf8");
const index = readFileSync(join(here, "index.js"), "utf8");

// historic.js: strip its trailing `export { ... };` block and turn it into a
// `return { ... }` so the IIFE exposes the same names.
const exportMatch = historic.match(/\nexport \{([\s\S]*?)\};?\s*$/);
if (!exportMatch) throw new Error("historic.js: could not find trailing export block");
const historicNames = exportMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
const historicBody = historic.slice(0, exportMatch.index) + `\nreturn { ${historicNames.join(", ")} };\n`;

// index.js: replace the `import { ... } from "./historic.js";` with a
// destructure from the IIFE namespace.
const importMatch = index.match(/import \{([\s\S]*?)\} from "\.\/historic\.js";\n/);
if (!importMatch) throw new Error("index.js: could not find historic.js import");
const importedNames = importMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
for (const n of importedNames) {
  if (!historicNames.includes(n)) throw new Error(`index.js imports ${n} but historic.js does not export it`);
}
const indexBody = index.replace(importMatch[0], `const { ${importedNames.join(", ")} } = __Historic;\n`);

const header = `// ===== SINGLE-FILE BUNDLE FOR CLOUDFLARE QUICK EDIT ==========================
// The dashboard's Quick Edit only supports one worker.js (no local module
// imports), so historic.js is inlined here inside a namespace IIFE and the
// names index.js imports are destructured out of it. The GitHub repo keeps
// the two files separate (worker/index.js + worker/historic.js); regenerate
// this bundle from them rather than editing it by hand:
//   node dashboards/fastbreak-refresh/worker/_bundle.mjs > worker.js
// ============================================================================
`;

process.stdout.write(`${header}const __Historic = (() => {\n${historicBody}})();\n${indexBody}`);
