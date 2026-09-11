import { cp, mkdir, rm } from "node:fs/promises";

const scriptDir = new URL(".", import.meta.url);
const src = new URL("../../web/dist", scriptDir);
const dest = new URL("../ui", scriptDir);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`UI bundled: ${src.pathname} -> ${dest.pathname}`);
