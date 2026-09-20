import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

export async function startPreview({ directory = fileURLToPath(new URL('../dist/', import.meta.url)), headers, port = 4321 } = {}) {
  const root = resolve(directory);
  const securityHeaders = headers ?? JSON.parse(await readFile(new URL('../.deploy/security-headers.json', import.meta.url), 'utf8'));
  await readFile(resolve(root, 'index.html'));
  const server = createServer(async (request, response) => {
    const respond = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.setHeader('Allow', 'GET, HEAD');
      respond(405, 'Method not allowed');
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${root}${sep}`) || pathname.split('/').some((part) => part.startsWith('.')) || !types[extname(path)]) throw new Error('Not found');
      const body = await readFile(path);
      respond(pathname === '/404.html' ? 404 : 200, body, types[extname(path)]);
    } catch {
      try {
        respond(404, await readFile(resolve(root, '404.html')), types['.html']);
      } catch {
        respond(404, 'Not found');
      }
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  console.log(`Local static preview with deployment headers: http://127.0.0.1:${port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await startPreview();
}