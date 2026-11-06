// Runs only in the isolated test process. No provider socket or real credential is used.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

https.request = (options, callback) => {
  if (options.hostname !== 'api.anthropic.com' || options.port !== 443 ||
    options.method !== 'POST' || options.path !== '/v1/messages' ||
    options.headers['x-api-key'] !== 'isolated-test-key') {
    throw new Error('Unexpected outbound request in the inference fixture');
  }
  const { agent, ...requestOptions } = options;
  return http.request({
    ...requestOptions,
    hostname: '127.0.0.1',
    port: Number(process.env.TEST_INFERENCE_PORT),
  }, callback);
};
syncBuiltinESMExports();
