import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const port = Number(process.env.PORT || 4179);
createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/geographic-map") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(readFileSync(new URL("../.local/geographic-map-preview.html", import.meta.url)));
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/geographic-map`));
