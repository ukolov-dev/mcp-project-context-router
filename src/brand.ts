import { loadProjectConfig, type ContextRouterBrandConfig } from './storage/config.js';

/** @deprecated Use getContextBrand() for project-configured output. */
export const ppmContextBrand = {
  name: 'Project Context Router',
  shortName: 'Project Context',
  marker: 'PROJECT_CONTEXT',
  logoText: '[Project Context]',
  description: 'local-first project memory, backlog, and verification router',
} as const;

export function getContextBrand(): ContextRouterBrandConfig {
  return loadProjectConfig().contextRouter.brand;
}

export function withBrand<T>(data: T): T & { brand: ContextRouterBrandConfig } {
  const brand = getContextBrand();
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      brand,
    } as T & { brand: ContextRouterBrandConfig };
  }
  return {
    brand,
    data,
  } as unknown as T & { brand: ContextRouterBrandConfig };
}
