import { describe, it, expect } from 'vitest';
import lifecycle from './lifecycle.js';

const { assertDockerUp } = lifecycle;

describe('assertDockerUp', () => {
  it('throws a docker-unavailable 503 when ping rejects', async () => {
    const docker = { ping: async () => { throw new Error('no daemon'); } };
    await expect(assertDockerUp(docker)).rejects.toMatchObject({
      statusCode: 503,
      code: 'docker-unavailable',
    });
  });

  it('resolves without throwing when ping succeeds', async () => {
    const docker = { ping: async () => 'OK' };
    await expect(assertDockerUp(docker)).resolves.toBeUndefined();
  });
});
