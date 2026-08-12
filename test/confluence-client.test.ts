import { describe, expect, it, vi } from 'vitest';
import {
  ConfluenceClient,
  assertPageInsideRoot,
  normalizeConfluenceBaseUrl,
  pageAllows,
  pageIsInsideRoot,
  parseConfluenceRootPageUrl,
  type ConfluencePage,
} from '../src/confluence/client.js';

function page(input: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: '123',
    type: 'page',
    title: 'Project root',
    ancestors: [],
    operations: [
      { operation: 'update', targetType: 'page' },
      { operation: 'create', targetType: 'page' },
    ],
    version: { number: 4 },
    space: { key: 'TEST' },
    ...input,
  };
}

describe('Confluence client security boundary', () => {
  it('accepts only the approved HTTPS host without embedded credentials', () => {
    expect(normalizeConfluenceBaseUrl('https://help.severstal.com/')).toBe('https://help.severstal.com');
    expect(() => normalizeConfluenceBaseUrl('http://help.severstal.com')).toThrow('HTTPS');
    expect(() => normalizeConfluenceBaseUrl('https://user:secret@help.severstal.com')).toThrow('credentials');
    expect(() => normalizeConfluenceBaseUrl('https://attacker.example')).toThrow('not approved');
  });

  it('extracts a canonical numeric page id from supported Confluence links', () => {
    expect(parseConfluenceRootPageUrl('https://help.severstal.com/pages/viewpage.action?pageId=123456')).toEqual({
      baseUrl: 'https://help.severstal.com',
      rootPageId: '123456',
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
    });
    expect(parseConfluenceRootPageUrl('https://help.severstal.com/pages/987654/project-root').rootPageId).toBe('987654');
    expect(() => parseConfluenceRootPageUrl('https://help.severstal.com/display/TEAM/Root')).toThrow('numeric pageId');
  });

  it('authorizes only the configured root and its descendants', () => {
    const config = { rootPageId: '123', includeRoot: true };
    expect(pageIsInsideRoot(page(), config)).toBe(true);
    expect(pageIsInsideRoot(page({ id: '456', ancestors: [{ id: '123' }] }), config)).toBe(true);
    expect(pageIsInsideRoot(page({ id: '789', ancestors: [{ id: '999' }] }), config)).toBe(false);
    expect(pageIsInsideRoot(page(), { ...config, includeRoot: false })).toBe(false);
  });

  it('fails closed when a fetched page is outside the project subtree', async () => {
    const client = {
      getPage: vi.fn().mockResolvedValue(page({ id: '789', ancestors: [{ id: '999' }] })),
    };
    await expect(assertPageInsideRoot(
      client as unknown as Pick<ConfluenceClient, 'getPage'>,
      '789',
      { rootPageId: '123', includeRoot: true },
    )).rejects.toThrow('outside the project root subtree');
  });

  it('allows the excluded root only as the parent of a new descendant', async () => {
    const client = {
      getPage: vi.fn().mockResolvedValue(page()),
    };
    await expect(assertPageInsideRoot(
      client as unknown as Pick<ConfluenceClient, 'getPage'>,
      '123',
      { rootPageId: '123', includeRoot: false },
      { allowRootAsParent: true },
    )).resolves.toMatchObject({ id: '123' });
    await expect(assertPageInsideRoot(
      client as unknown as Pick<ConfluenceClient, 'getPage'>,
      '123',
      { rootPageId: '123', includeRoot: false },
    )).rejects.toThrow('outside the project root subtree');
  });

  it('uses Bearer auth without redirecting and normalizes page metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(page()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new ConfluenceClient('https://help.severstal.com', 'DUMMY_TEST_PAT', { fetch: fetchMock });

    const result = await client.getPage('123', { includeBody: true });

    expect(result.id).toBe('123');
    expect(pageAllows(result, 'update')).toBe(true);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/rest/api/content/123');
    expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer DUMMY_TEST_PAT');
    expect(request?.redirect).toBe('error');
  });

  it('does not include response bodies or credentials in request failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('token=DUMMY_TEST_PAT', { status: 403 }));
    const client = new ConfluenceClient('https://help.severstal.com', 'DUMMY_TEST_PAT', { fetch: fetchMock });

    await expect(client.getPage('123')).rejects.toThrow('HTTP 403');
    await expect(client.getPage('123')).rejects.not.toThrow('DUMMY_TEST_PAT');
  });
});
