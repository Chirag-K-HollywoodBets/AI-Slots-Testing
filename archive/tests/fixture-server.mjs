import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtures = new Map([
  ['/', new URL('../fixtures/ai-fixture.html', import.meta.url)],
  ['/index.html', new URL('../fixtures/ai-fixture.html', import.meta.url)],
  ['/sports', new URL('../fixtures/sports-competitions.html', import.meta.url)],
  ['/events', new URL('../fixtures/football-events.html', import.meta.url)],
  ['/betslip', new URL('../fixtures/soccer-betslip.html', import.meta.url)],
]);
const port = Number(process.env.PORT ?? 4173);

createServer(async (request, response) => {
  const fixtureUrl = fixtures.get(request.url);
  if (!fixtureUrl) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const html = await readFile(fileURLToPath(fixtureUrl));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  } catch {
    response.writeHead(500);
    response.end('Fixture unavailable');
  }
}).listen(port, '127.0.0.1');
