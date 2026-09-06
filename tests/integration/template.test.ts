import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../helpers/test-env.js';
import type { TestContext } from '../helpers/setup-dsl.js';
import { workingDirectoryIs } from '../helpers/setup-dsl.js';
import { runCommand } from '../helpers/action-dsl.js';
import { expectCommandSucceeded, expectDisplayedMessage } from '../helpers/assert-dsl.js';
import { resolveProjectManifest } from '../../src/lib/project-manifest.js';

const execFileAsync = promisify(execFile);

async function writeFileRecursive(root: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf-8');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'EAI CLI Tests',
      GIT_AUTHOR_EMAIL: 'tests@example.com',
      GIT_COMMITTER_NAME: 'EAI CLI Tests',
      GIT_COMMITTER_EMAIL: 'tests@example.com',
    },
  });

  return stdout.trim();
}

async function createTemplateRepo(repoRoot: string): Promise<{ initialCommit: string; latestCommit: string }> {
  await mkdir(repoRoot, { recursive: true });
  await writeFileRecursive(repoRoot, 'package.json', JSON.stringify({ name: '@eai-tools/eai-app-template-fixture', version: '0.1.0' }, null, 2) + '\n');
  await writeFileRecursive(repoRoot, 'src/components/Hero.tsx', 'export function Hero() { return <div>Hero v1</div>; }\n');
  await writeFileRecursive(repoRoot, 'src/app/page.tsx', 'export default function Page() { return <Hero />; }\n');
  await writeFileRecursive(
    repoRoot,
    'src/app/home-client.tsx',
    [
      "import { DemoPage } from '@enterpriseaigroup/demo';",
      '',
      'export function HomeClient() {',
      '  return <DemoPage />;',
      '}',
      '',
    ].join('\n'),
  );

  await git(repoRoot, ['init']);
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'initial template']);
  const initialCommit = await git(repoRoot, ['rev-parse', 'HEAD']);

  await writeFileRecursive(repoRoot, 'src/components/Hero.tsx', 'export function Hero() { return <div>Hero v2</div>; }\n');
  await writeFileRecursive(repoRoot, 'src/components/Badge.tsx', 'export function Badge() { return <span>New UI</span>; }\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'template ui refresh']);
  const latestCommit = await git(repoRoot, ['rev-parse', 'HEAD']);

  return { initialCommit, latestCommit };
}

describe('eai template check', () => {
  let env: TestEnvironment;
  let ctx: TestContext;

  beforeEach(async () => {
    env = await createTestEnvironment();
    ctx = {
      workingDir: env.dir,
      mockAPI: {} as TestContext['mockAPI'],
      env: {},
      prompts: [],
    };

    workingDirectoryIs(ctx, env.dir);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test('previews template and UI drift without writing files', async () => {
    const templateRepo = join(tmpdir(), `eai-template-source-${Date.now()}`);
    const { initialCommit } = await createTemplateRepo(templateRepo);

    await writeFileRecursive(env.dir, 'package.json', JSON.stringify({
      name: '@eai-tools/template-check-fixture',
      version: '0.0.1',
      dependencies: {
        '@eai-tools/core': '1.0.0',
      },
    }, null, 2) + '\n');
    await writeFileRecursive(env.dir, 'src/eai.config/object-types.ts', 'export const objectTypes = {};\n');
    await writeFileRecursive(env.dir, 'src/components/Hero.tsx', 'export function Hero() { return <div>Hero v1</div>; }\n');
    await writeFileRecursive(env.dir, '.eai-manifest.json', JSON.stringify({
      schemaVersion: 1,
      template: {
        repo: templateRepo,
        commit: initialCommit,
        displaySource: `${templateRepo}@${initialCommit.slice(0, 7)}`,
      },
    }, null, 2) + '\n');

    const result = await runCommand(ctx, 'eai template check');

    expectCommandSucceeded(result);
    expectDisplayedMessage(result, 'Template Check');
    expectDisplayedMessage(result, 'Current comparison source');
    expectDisplayedMessage(result, 'src/components/Hero.tsx');
    expectDisplayedMessage(result, 'src/components/Badge.tsx');
    expectDisplayedMessage(result, 'Files needing manual review');
    expectDisplayedMessage(result, 'UI files in review set');
    expectDisplayedMessage(result, 'High-risk entrypoint detected: src/app/home-client.tsx controls the root app experience.');
  });

  test('infers template provenance from a legacy eai init scaffold commit when the manifest is missing', async () => {
    const templateRepo = join(tmpdir(), `eai-template-source-${Date.now()}-legacy`);
    await createTemplateRepo(templateRepo);

    await writeFileRecursive(env.dir, 'package.json', JSON.stringify({
      name: '@eai-tools/template-check-legacy-fixture',
      version: '0.0.1',
      dependencies: {
        '@enterpriseaigroup/core': '1.0.0',
      },
    }, null, 2) + '\n');
    await writeFileRecursive(env.dir, 'src/eai.config/object-types.ts', 'export const objectTypes = {};\n');
    await writeFileRecursive(env.dir, 'src/eai.config/default.ts', 'export default {};\n');
    await writeFileRecursive(env.dir, '.specify/spec.json', '{}\n');
    await writeFileRecursive(env.dir, 'src/components/Hero.tsx', 'export function Hero() { return <div>Hero v1</div>; }\n');

    await git(env.dir, ['init']);
    await git(env.dir, ['add', '.']);
    await git(
      env.dir,
      ['commit', '-m', `Initial scaffold from template\n\nApp: Legacy Fixture\nCreated by: eai init\nTemplate: ${templateRepo}`],
    );

    const result = await runCommand(ctx, 'eai template check');

    expectCommandSucceeded(result);
    expectDisplayedMessage(result, 'Template provenance was inferred from the original `eai init` scaffold commit');
    expectDisplayedMessage(result, 'src/components/Hero.tsx');
    expectDisplayedMessage(result, 'src/components/Badge.tsx');
  });

  test('normalizes legacy eai-tools template labels from eai init scaffold commits', async () => {
    await writeFileRecursive(env.dir, 'package.json', JSON.stringify({
      name: '@eai-tools/template-check-legacy-label-fixture',
      version: '0.0.1',
    }, null, 2) + '\n');

    await git(env.dir, ['init']);
    await git(env.dir, ['add', '.']);
    await git(
      env.dir,
      [
        'commit',
        '-m',
        'Initial scaffold from template\n\nApp: Legacy Fixture\nCreated by: eai init\nTemplate: eai-tools/eai-app-template@abc1234',
      ],
    );

    const result = await resolveProjectManifest(env.dir);

    expect(result.source).toBe('inferred-init-commit');
    expect(result.manifest?.template?.repo).toBe('https://github.com/eai-support/eai-app-template.git');
    expect(result.manifest?.template?.commit).toBe('abc1234');
    expect(result.manifest?.template?.displaySource).toBe('eai-tools/eai-app-template@abc1234');
  });

  test('warns when App Router route.ts files export unsupported symbols', async () => {
    const templateRepo = join(tmpdir(), `eai-template-source-${Date.now()}-routes`);
    const { initialCommit } = await createTemplateRepo(templateRepo);

    await writeFileRecursive(env.dir, 'package.json', JSON.stringify({
      name: '@eai-tools/template-check-routes-fixture',
      version: '0.0.1',
      dependencies: {
        '@enterpriseaigroup/core': '1.0.0',
      },
    }, null, 2) + '\n');
    await writeFileRecursive(env.dir, 'src/eai.config/object-types.ts', 'export const objectTypes = {};\n');
    await writeFileRecursive(env.dir, 'src/app/api/demo/route.ts', [
      "import { NextRequest, NextResponse } from 'next/server';",
      '',
      'export interface DemoDeps {',
      '  readonly name: string;',
      '}',
      '',
      'export async function runDemo(_request: NextRequest): Promise<NextResponse> {',
      "  return NextResponse.json({ ok: true });",
      '}',
      '',
      'export async function GET(request: NextRequest): Promise<NextResponse> {',
      '  return runDemo(request);',
      '}',
      '',
    ].join('\n'));
    await writeFileRecursive(env.dir, '.eai-manifest.json', JSON.stringify({
      schemaVersion: 1,
      template: {
        repo: templateRepo,
        commit: initialCommit,
        displaySource: `${templateRepo}@${initialCommit.slice(0, 7)}`,
      },
    }, null, 2) + '\n');

    const result = await runCommand(ctx, 'eai template check');

    expectCommandSucceeded(result);
    expectDisplayedMessage(result, 'App Router route export audit found unsupported exports');
    expectDisplayedMessage(result, 'src/app/api/demo/route.ts: DemoDeps, runDemo');
    expectDisplayedMessage(result, 'Move reusable helpers, dependency interfaces, and test seams into a sibling `handler.ts` or a lib module.');
  });

  test('warns when a project duplicates object-type slug logic or hand-writes resource routes', async () => {
    const templateRepo = join(tmpdir(), `eai-template-source-${Date.now()}-object-type-audit`);
    const { initialCommit } = await createTemplateRepo(templateRepo);

    await writeFileRecursive(env.dir, 'package.json', JSON.stringify({
      name: '@eai-tools/template-check-object-type-fixture',
      version: '0.0.1',
      dependencies: {
        '@enterpriseaigroup/core': '1.0.0',
      },
    }, null, 2) + '\n');
    await writeFileRecursive(env.dir, 'src/eai.config/object-types.ts', 'export const objectTypes = {};\n');
    await writeFileRecursive(env.dir, 'src/lib/platform/custom-resource-client.ts', [
      'export function objectTypeSlug(objectType: string): string {',
      "  return objectType.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();",
      '}',
      '',
      "export const watchTargetUrl = '/v4/data/resources/tenant-a/WatchTarget';",
    ].join('\n'));
    await writeFileRecursive(env.dir, '.eai-manifest.json', JSON.stringify({
      schemaVersion: 1,
      template: {
        repo: templateRepo,
        commit: initialCommit,
        displaySource: `${templateRepo}@${initialCommit.slice(0, 7)}`,
      },
    }, null, 2) + '\n');

    const result = await runCommand(ctx, 'eai template check');

    expectCommandSucceeded(result);
    expectDisplayedMessage(result, 'Object-type normalization audit found identifier drift risks');
    expectDisplayedMessage(result, 'src/lib/platform/custom-resource-client.ts: Custom object-type slug normalization found outside the shared helper');
    expectDisplayedMessage(result, 'src/lib/platform/custom-resource-client.ts: Direct v4 data resource route usage found outside the approved SDK/BFF files');
  });
});
