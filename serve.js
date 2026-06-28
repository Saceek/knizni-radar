const http = require("http");
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const TYPES = {
  ".html": "text/html;charset=utf-8", ".json": "application/json",
  ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};
http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const file = path.join(DIR, url === "/" ? "index.html" : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(3456, () => console.log("http://localhost:3456"));
