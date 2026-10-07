import { describe, expect, it } from 'vitest';

import { isCloudEndpoint } from './endpoint.js';

describe('isCloudEndpoint', () => {
  it.each([
    // local / private → not cloud
    ['http://localhost:8000', false],
    ['http://LOCALHOST/v1', false],
    ['localhost:11434', false],
    ['http://127.0.0.1:8000', false],
    ['http://127.255.255.254', false],
    ['http://[::1]:8000', false],
    ['http://10.0.0.5:8000', false],
    ['http://10.255.1.1', false],
    ['http://172.16.0.1', false],
    ['http://172.31.255.255', false],
    ['https://192.168.1.20:8443', false],
    ['http://gpu-box.local:8000', false],
    ['http://my-mac.local', false],
    // cloud
    ['https://api.openai.com/v1', true],
    ['https://api.anthropic.com', true],
    ['http://172.15.0.1', true],
    ['http://172.32.0.1', true],
    ['http://192.169.1.1', true],
    ['http://11.0.0.1', true],
    ['http://8.8.8.8', true],
    ['http://128.0.0.1', true],
    ['https://models.example.com:443', true],
    ['https://notlocal.example.com', true],
    ['https://localhost.example.com', true],
    ['https://10.example.com', true],
    ['https://local', true],
    // unparseable → cloud (safe default)
    ['', true],
    ['http://', true],
    ['http://999.1.1.1', true],
  ])('%s → %s', (url, expected) => {
    expect(isCloudEndpoint(url)).toBe(expected);
  });
});
