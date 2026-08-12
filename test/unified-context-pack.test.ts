import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildUnifiedContextPack } from '../src/context-pack/unified.js';
import { sha256, type PortalClient, type PortalContextPack } from '../src/portal/client.js';
import type { ContextPack } from '../src/context-pack/pack.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const chunkId = '00000000-0000-4000-8000-000000000003';
const documentId = '00000000-0000-4000-8000-000000000004';
const revisionId = '00000000-0000-4000-8000-000000000005';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'unified-context-pack-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Unified pack
modules: {}
commands: {}
integrations:
  portal:
    schema_version: 2
    base_url: https://portal.example.test
    project_id: ${projectId}
    project_key: UNIFIED
    project_name: Unified pack
    cache_path: .project-context/indexes/portal
    credential_ref: native:test/token
`, 'utf8');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('unified context pack', () => {
  it('preserves Portal and local authority labels under one deterministic token budget', async () => {
    const portalPack: PortalContextPack = {
      contextSessionId: sessionId,
      digest: sha256('portal'),
      query: 'evidence',
      intent: 'proposal',
      maximumTokens: 700,
      actualTokens: 200,
      truncated: false,
      items: [{
        rank: 1,
        chunkId,
        artifactKey: 'document:1',
        artifactType: 'DOCUMENT_REVISION',
        authority: 'PUBLISHED',
        retrievalPolicy: 'CURRENT',
        sourceId: null,
        documentId,
        revisionId,
        contentDigest: sha256('published'),
        headingPath: 'Evidence',
        excerpt: 'Published evidence',
        tokenCount: 200,
        score: 3,
        reason: 'published authority',
        mandatory: false,
        pinned: false,
        stale: false,
        truncated: false,
        conflictMarkers: [],
      }],
      droppedItems: [],
      unknowns: [],
    };
    const client = {
      retrieveContext: async () => portalPack,
    } as unknown as PortalClient;
    const localBuilder = (): ContextPack => ({
      summary: 'local',
      profile: 'default',
      workflow: 'fast',
      maxTokens: 800,
      records: [{
        id: 'REQUIREMENT-1',
        path: '.project-context/active/requirements/REQUIREMENT-1.md',
        reason: 'Relevant local requirement.',
        excerpt: 'L'.repeat(3_200),
      }],
      files: [],
      playbooks: [],
      playbookDetails: [],
      commands: [],
      warnings: [],
      budget: {
        limit: 800,
        estimatedTokens: 800,
        payloadTokens: 800,
        playbookTokens: 0,
        exceedsLimit: false,
        truncated: false,
        droppedRecords: 0,
        droppedFiles: 0,
        droppedPlaybooks: 0,
      },
    });

    const pack = await buildUnifiedContextPack({
      query: 'evidence',
      intent: 'proposal',
      maximumTokens: 1_000,
      topK: 10,
    }, { client, localBuilder });

    expect(pack.actualTokens).toBeLessThanOrEqual(1_000);
    expect(pack.allocations).toEqual({ portalTokens: 200, localTokens: 800 });
    expect(pack.items.map((value) => value.authority)).toEqual([
      'PUBLISHED',
      'LOCAL_PROJECT_CONTEXT',
    ]);
    expect(pack.items[1]).toMatchObject({
      truncated: false,
      sourceId: 'REQUIREMENT-1',
    });
    expect(pack.digest).toHaveLength(64);
  });
});
