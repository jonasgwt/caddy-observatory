import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdaptOutput, parseAdaptedCaddyConfig } from '../src/discovery.ts';

test('parseAdaptedCaddyConfig extracts host and upstream', () => {
  const adapted = {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            routes: [
              {
                match: [{ host: ['portal.localhost'] }],
                handle: [
                  {
                    handler: 'subroute',
                    routes: [
                      {
                        handle: [
                          {
                            handler: 'reverse_proxy',
                            upstreams: [{ dial: 'localhost:8080' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };

  const parsed = parseAdaptedCaddyConfig(adapted);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    host: 'portal.localhost',
    scheme: 'https',
    upstreamHost: 'localhost',
    upstreamPort: 8080,
  });
});

test('parseAdaptOutput tolerates leading warning JSON', () => {
  const raw = '{"level":"warn","msg":"format warning"}\n{"apps":{"http":{"servers":{}}}}';
  const parsed = parseAdaptOutput(raw) as Record<string, unknown>;
  assert.ok(parsed.apps);
});
