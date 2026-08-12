import type { ConfluenceIntegrationConfig } from '../storage/config.js';

export const defaultConfluenceBaseUrl = 'https://help.severstal.com';
export const defaultConfluenceAllowedHosts = ['help.severstal.com'] as const;

export type ConfluenceOperation = {
  operation?: string;
  targetType?: string;
};

export type ConfluencePage = {
  id: string;
  type: string;
  title: string;
  ancestors: Array<{ id: string; title?: string }>;
  space?: { key?: string; name?: string };
  version?: { number?: number; when?: string; by?: { displayName?: string; username?: string } };
  operations: ConfluenceOperation[];
  body?: { storage?: { value?: string; representation?: string } };
  _links?: { webui?: string; base?: string };
};

export type ConfluenceIdentity = {
  username?: string;
  userKey?: string;
  displayName?: string;
  type?: string;
};

type Fetch = typeof fetch;

type ClientOptions = {
  fetch?: Fetch;
  timeoutMs?: number;
  allowedHosts?: Iterable<string>;
};

export function normalizeConfluenceBaseUrl(
  input = defaultConfluenceBaseUrl,
  allowedHosts: Iterable<string> = defaultConfluenceAllowedHosts,
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Confluence URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Confluence URL must use HTTPS.');
  if (url.username || url.password) throw new Error('Confluence URL must not contain credentials.');
  const approved = new Set([...allowedHosts].map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!approved.has(url.hostname.toLowerCase())) {
    throw new Error(`Confluence host is not approved: ${url.hostname}`);
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function parseConfluenceRootPageUrl(
  input: string,
  options: { allowedHosts?: Iterable<string> } = {},
): { baseUrl: string; rootPageId: string; rootPageUrl: string } {
  let pageUrl: URL;
  try {
    pageUrl = new URL(input);
  } catch {
    throw new Error('Root page must be a valid Confluence HTTPS URL.');
  }
  const baseUrl = normalizeConfluenceBaseUrl(pageUrl.origin, options.allowedHosts);
  const queryId = pageUrl.searchParams.get('pageId')?.trim();
  const pathId = /\/pages\/(\d+)(?:\/|$)/.exec(pageUrl.pathname)?.[1];
  const rootPageId = queryId || pathId;
  if (!rootPageId || !/^\d+$/.test(rootPageId)) {
    throw new Error('Root page URL must contain a numeric pageId.');
  }
  pageUrl.hash = '';
  return {
    baseUrl,
    rootPageId,
    rootPageUrl: pageUrl.toString(),
  };
}

export class ConfluenceClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
    if (!token) throw new Error('Confluence Personal Access Token is required.');
    this.baseUrl = normalizeConfluenceBaseUrl(baseUrl, options.allowedHosts);
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getCurrentUser(): Promise<ConfluenceIdentity> {
    return this.#request<ConfluenceIdentity>('/rest/api/user/current');
  }

  async getPage(pageId: string, options: { includeBody?: boolean } = {}): Promise<ConfluencePage> {
    const id = pageIdValue(pageId);
    const expand = [
      'ancestors',
      'space',
      'version',
      'operations',
      ...(options.includeBody ? ['body.storage'] : []),
    ].join(',');
    const page = await this.#request<ConfluencePage>(`/rest/api/content/${encodeURIComponent(id)}?expand=${encodeURIComponent(expand)}`);
    return normalizePage(page);
  }

  async createPage(input: {
    parentPageId: string;
    spaceKey: string;
    title: string;
    storageValue: string;
  }): Promise<ConfluencePage> {
    const parentPageId = pageIdValue(input.parentPageId);
    const spaceKey = String(input.spaceKey ?? '').trim();
    if (!spaceKey) throw new Error(`Confluence parent page ${parentPageId} has no space key.`);
    return normalizePage(await this.#request<ConfluencePage>('/rest/api/content', {
      method: 'POST',
      body: JSON.stringify({
        type: 'page',
        title: nonEmptyTitle(input.title),
        ancestors: [{ id: parentPageId }],
        space: { key: spaceKey },
        body: {
          storage: {
            value: input.storageValue,
            representation: 'storage',
          },
        },
      }),
    }));
  }

  async updatePage(input: {
    pageId: string;
    title: string;
    expectedVersion: number;
    storageValue: string;
  }): Promise<ConfluencePage> {
    const id = pageIdValue(input.pageId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('Confluence expected page version must be a positive integer.');
    }
    return normalizePage(await this.#request<ConfluencePage>(`/rest/api/content/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id,
        type: 'page',
        title: nonEmptyTitle(input.title),
        version: {
          number: input.expectedVersion + 1,
          minorEdit: true,
        },
        body: {
          storage: {
            value: input.storageValue,
            representation: 'storage',
          },
        },
      }),
    }));
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error('Confluence request escaped the approved origin.');
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(`Confluence request failed for ${url.pathname}.`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Confluence request failed for ${url.pathname} with HTTP ${response.status}.`);
    }
    try {
      return await response.json() as T;
    } catch (error) {
      throw new Error(`Confluence returned invalid JSON for ${url.pathname}.`, { cause: error });
    }
  }
}

export function pageIsInsideRoot(
  page: Pick<ConfluencePage, 'id' | 'ancestors'>,
  config: Pick<ConfluenceIntegrationConfig, 'rootPageId' | 'includeRoot'>,
): boolean {
  if (page.id === config.rootPageId) return config.includeRoot;
  return page.ancestors.some((ancestor) => ancestor.id === config.rootPageId);
}

export async function assertPageInsideRoot(
  client: Pick<ConfluenceClient, 'getPage'>,
  pageId: string,
  config: Pick<ConfluenceIntegrationConfig, 'rootPageId' | 'includeRoot'>,
  options: { includeBody?: boolean; allowRootAsParent?: boolean } = {},
): Promise<ConfluencePage> {
  const page = await client.getPage(pageId, options);
  if (!(options.allowRootAsParent && page.id === config.rootPageId) && !pageIsInsideRoot(page, config)) {
    throw new Error(`Confluence page ${page.id} is outside the project root subtree.`);
  }
  return page;
}

export function pageAllows(page: ConfluencePage, operation: 'update'): boolean {
  return page.operations.some((candidate) => candidate.operation === operation
    && (!candidate.targetType || candidate.targetType === 'page'));
}

function normalizePage(page: ConfluencePage): ConfluencePage {
  const id = pageIdValue(page?.id);
  if (page.type && page.type !== 'page') throw new Error(`Confluence content ${id} is not a page.`);
  return {
    ...page,
    id,
    type: 'page',
    title: nonEmptyTitle(page.title),
    ancestors: Array.isArray(page.ancestors)
      ? page.ancestors.map((ancestor) => ({ ...ancestor, id: pageIdValue(ancestor.id) }))
      : [],
    operations: Array.isArray(page.operations) ? page.operations : [],
  };
}

function pageIdValue(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Confluence page ID must be numeric.');
  return id;
}

function nonEmptyTitle(value: unknown): string {
  const title = String(value ?? '').trim();
  if (!title) throw new Error('Confluence page title is required.');
  if (title.length > 255) throw new Error('Confluence page title is too long.');
  return title;
}
