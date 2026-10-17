import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".task": "application/octet-stream" };
export function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const relative = decodeURIComponent(url.pathname).replace(/^\/mi-tsuketa\//, "/");
      const filename = path.resolve(root, `.${relative.endsWith("/") ? relative + "index.html" : relative}`);
      if (!filename.startsWith(root + path.sep)) throw new Error("outside-root");
      const data = await readFile(filename);
      response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-cache" });
      response.end(data);
    } catch { response.writeHead(404); response.end("Not found"); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(Number(process.env.PORT || 4173), "127.0.0.1", () => console.log("http://127.0.0.1:4173/mi-tsuketa/"));
}
