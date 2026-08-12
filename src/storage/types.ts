import type { RecordType } from './record-types.js';

export type { ProjectKnowledgeRecordType, RecordType } from './record-types.js';

export type ContextRecord = {
  id: string;
  type: RecordType | string;
  status: string;
  title: string;
  path: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  retention: string;
  archived: boolean;
  modules: string[];
  files: string[];
  deletedFiles: string[];
  tags: string[];
  frontmatter: Record<string, unknown>;
};

export type Capability = {
  id: string;
  name: string;
  kind: string;
  module?: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  exported: boolean;
};

export type Endpoint = {
  id: string;
  method: string;
  path: string;
  module: string;
  controllerSymbolId?: string;
  filePath: string;
};

export type CommandResult = {
  ok: boolean;
  data?: unknown;
  errors?: string[];
  warnings?: string[];
};
