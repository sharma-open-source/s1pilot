import { describe, expect, it } from 'vitest';

import { joinUrl } from './http.js';

describe('joinUrl', () => {
  it('appends the path to a bare host', () => {
    expect(joinUrl('http://127.0.0.1:8000/', '/v1/chat/completions')).toBe('http://127.0.0.1:8000/v1/chat/completions');
  });

  it('does not repeat a version segment the base already ends with', () => {
    expect(joinUrl('https://openrouter.ai/api/v1', '/v1/chat/completions')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(joinUrl('https://api.openai.com/v1/', '/v1/models')).toBe('https://api.openai.com/v1/models');
  });

  it('keeps bases that only look similar', () => {
    expect(joinUrl('https://openrouter.ai/api', '/v1/chat/completions')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(joinUrl('https://host/apiv1x', '/v1/decide')).toBe('https://host/apiv1x/v1/decide');
  });
});
