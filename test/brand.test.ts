import { describe, expect, it } from 'vitest';
import { getContextBrand, withBrand } from '../src/brand.js';

describe('configured project-context brand metadata', () => {
  it('adds a stable marker to object payloads without changing existing fields', () => {
    const result = withBrand({ project: 'PPM', status: 'ok' });
    const configured = getContextBrand();

    expect(result.project).toBe('PPM');
    expect(result.status).toBe('ok');
    expect(result.brand.marker).toBe(configured.marker);
    expect(result.brand.logoText).toBe(configured.logoText);
  });

  it('keeps router brand metadata authoritative', () => {
    const result = withBrand({ brand: { marker: 'OTHER' }, data: true });

    expect(result.brand).toEqual(getContextBrand());
    expect(result.brand.marker).toBe(getContextBrand().marker);
    expect(result.data).toBe(true);
  });

  it('wraps non-object payloads with a data field', () => {
    const result = withBrand(['TASK-1', 'TASK-2']);

    expect(result.brand.marker).toBe(getContextBrand().marker);
    expect(result.data).toEqual(['TASK-1', 'TASK-2']);
  });
});
