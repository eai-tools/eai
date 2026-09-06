/**
 * eai verify — run platform connectivity checks.
 * eai doctor — comprehensive diagnostics with fix suggestions.
 */

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import ora from "ora";
import chalk from "chalk";
import {
  findProjectRoot,
  loadEnvFile,
  loadObjectTypes,
} from "../lib/config.js";
import { isAuthenticated, loadTokens } from "../lib/auth.js";
import { PlatformAPIClient } from "../lib/api.js";
import {
  normalizeTenantEntries,
  resolveActiveTenantContext,
  resolvePublicApiUrl,
} from "../lib/tenant-context.js";
import { isRecord } from "../lib/utils.js";
import * as out from "../lib/output.js";
import { ErrorCode, exitWithError } from "../lib/error-codes.js";
import { findGuidance } from "../lib/error-guidance/match.js";
import { compareVersions, fetchLatestRelease } from "../lib/update-check.js";
import { readGoferBundleMetadata } from "../lib/gofer-refresh.js";
import { resolveProjectManifest } from "../lib/project-manifest.js";
import { isDefaultTemplateSource, resolveTemplateClonePlan } from "./init.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
const DEFAULT_TEMPLATE_SOURCE =
  "https://github.com/eai-support/eai-app-template.git";

interface VerifyEnvironment {
  root: string;
  env: Record<string, string>;
  publicApiUrl: string;
  tenantId?: string;
  workflowId?: string;
}

export interface ContractAuditOptions {
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  workflowId?: string;
  stage?: string;
  tenantRecordId?: string;
  userEmail?: string;
  includeChat?: boolean;
  chatMessage?: string;
}

export interface ContractCheckResult {
  id: string;
  label: string;
  method: string;
  endpoint: string;
  status: "passed" | "failed" | "skipped";
  details: string;
}

/** Machine-readable call coverage, including the reason for every skipped check. */
export interface ContractAuditReport {
  generatedAt: string;
  publicApiUrl: string;
  tenantId?: string;
  workflowId?: string;
  checks: ContractCheckResult[];
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    coverageComplete: boolean;
  };
}

async function loadVerifyEnvironment(options?: {
  tenantId?: string;
}): Promise<VerifyEnvironment> {
  const root = await findProjectRoot();
  if (!root) {
    exitWithError(ErrorCode.E001);
  }

  const envVars = await loadEnvFile(root);
  const env = { ...envVars, ...process.env } as Record<string, string>;
  let publicApiUrl = await resolvePublicApiUrl(root);

  let tenantId: string | undefined = options?.tenantId;
  if (tenantId) {
    const activeContext = await resolveActiveTenantContext({
      projectRoot: root,
      publicApiUrl,
      tenantId,
      interactive: false,
      forceRefresh: true,
    });
    tenantId = activeContext.activeTenant.id;
    publicApiUrl = activeContext.publicApiUrl;
  } else {
    try {
      const activeContext = await resolveActiveTenantContext({
        projectRoot: root,
        publicApiUrl,
        interactive: false,
      });
      tenantId = activeContext.activeTenant.id;
    } catch {
      tenantId = undefined;
    }
  }

  return {
    root,
    env,
    publicApiUrl,
    tenantId,
    workflowId:
      env.WORKFLOW_DEFAULT_ID ||
      Object.keys(env)
        .filter((key) => key.startsWith("WORKFLOW_") && key.endsWith("_ID"))
        .map((key) => env[key])
        .find(Boolean),
  };
}

function extractTenantIdOption(options: {
  tenantId?: unknown;
}): string | undefined {
  if (typeof options?.tenantId === "string" && options.tenantId.trim()) {
    return options.tenantId.trim();
  }

  const parentTenantId = verifyCommand.opts()?.tenantId;
  if (typeof parentTenantId === "string" && parentTenantId.trim()) {
    return parentTenantId.trim();
  }

  const equalsArg = process.argv.find((arg) => arg.startsWith("--tenant-id="));
  if (equalsArg) {
    return equalsArg.slice("--tenant-id=".length).trim();
  }

  const index = process.argv.indexOf("--tenant-id");
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return undefined;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Expected JSON response but received: ${text.slice(0, 120)}`,
    );
  }
}

function addCheck(
  checks: ContractCheckResult[],
  check: ContractCheckResult,
): void {
  checks.push(check);
}

function summarizeChecks(
  checks: ContractCheckResult[],
): ContractAuditReport["summary"] {
  const counts = checks.reduce(
    (summary, check) => {
      summary[check.status]++;
      return summary;
    },
    {
      passed: 0,
      failed: 0,
      skipped: 0,
    },
  );
  return {
    ...counts,
    coverageComplete: counts.skipped === 0,
  };
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (isRecord(value)) {
    return `object keys: ${Object.keys(value).join(", ") || "(none)"}`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function extractSchemaTypeCount(payload: unknown): number {
  if (!isRecord(payload)) {
    return 0;
  }

  if (Array.isArray(payload.objectTypes)) {
    return payload.objectTypes.length;
  }

  if (Array.isArray(payload.object_types)) {
    return payload.object_types.length;
  }

  if (!Array.isArray(payload.docs)) {
    return 0;
  }

  return payload.docs.filter(
    (value) =>
      isRecord(value) &&
      (value.status === "published" ||
        (value.publishedAt !== null && value.publishedAt !== undefined)),
  ).length;
}

function renderContractAudit(report: ContractAuditReport): void {
  out.heading("Platform Call Audit");
  out.info(`PublicAPI: ${report.publicApiUrl}`);
  if (report.tenantId) {
    out.info(`Tenant: ${report.tenantId}`);
  }
  if (report.workflowId) {
    out.info(`Workflow: ${report.workflowId}`);
  }
  out.blank();

  for (const check of report.checks) {
    const icon =
      check.status === "passed"
        ? out.symbols.success
        : check.status === "failed"
          ? out.symbols.error
          : out.symbols.warning;
    out.info(`${icon} ${check.label}`);
    out.dim(`  ${check.method} ${check.endpoint}`);
    out.dim(`  ${check.details}`);
  }

  out.blank();
  if (report.summary.failed === 0) {
    if (report.summary.skipped > 0) {
      out.warn(
        `${report.summary.passed} passed, ${report.summary.skipped} skipped — verification is incomplete; skipped checks are not passes and each reason is listed above.`,
      );
    } else {
      out.success(`${report.summary.passed} passed, 0 skipped — all declared checks were exercised.`);
    }
  } else {
    out.warn(
      `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped — review every failed and skipped reason above.`,
    );
  }
}

function collectPublishedStorageBackends(
  objectTypesByScope: Record<
    string,
    Array<{ status?: string; storageBackend?: string }>
  >,
): { backends: string[]; invalid: string[] } {
  const backends = new Set<string>();
  const invalid = new Set<string>();
  const allowed = new Set(["postgresql", "documentdb", "blob", "search"]);

  for (const types of Object.values(objectTypesByScope)) {
    for (const objectType of types) {
      if (objectType.status && objectType.status !== "published") {
        continue;
      }
      if (!objectType.storageBackend) {
        continue;
      }
      backends.add(objectType.storageBackend);
      if (!allowed.has(objectType.storageBackend)) {
        invalid.add(objectType.storageBackend);
      }
    }
  }

  return {
    backends: [...backends].sort(),
    invalid: [...invalid].sort(),
  };
}

export async function runContractAudit(
  options: ContractAuditOptions,
): Promise<ContractAuditReport> {
  const context = await loadVerifyEnvironment({ tenantId: options.tenantId });
  const checks: ContractCheckResult[] = [];
  let remoteObjectTypeCount: number | null = null;
  const workflowId = options.workflowId || context.workflowId;
  const stage = options.stage || "chat";
  const client = context.tenantId
    ? new PlatformAPIClient(context.publicApiUrl, context.tenantId)
    : null;
  const systemClient = new PlatformAPIClient(context.publicApiUrl, "system");

  // Public API health
  try {
    const start = Date.now();
    const res = await fetch(`${context.publicApiUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - start;
    if (res.ok || res.status === 404) {
      addCheck(checks, {
        id: "health",
        label: "PublicAPI health",
        method: "GET",
        endpoint: "/health",
        status: "passed",
        details: `Reachable in ${latency}ms (status ${res.status})`,
      });
    } else {
      addCheck(checks, {
        id: "health",
        label: "PublicAPI health",
        method: "GET",
        endpoint: "/health",
        status: "failed",
        details: `Unexpected status ${res.status}`,
      });
    }
  } catch (err) {
    addCheck(checks, {
      id: "health",
      label: "PublicAPI health",
      method: "GET",
      endpoint: "/health",
      status: "failed",
      details: err instanceof Error ? err.message : String(err),
    });
  }

  const authenticated = await isAuthenticated();
  const tokens = await loadTokens();
  addCheck(checks, {
    id: "auth",
    label: "Authentication token",
    method: "LOCAL",
    endpoint: "~/.eai/tokens.json or EAI_ACCESS_TOKEN",
    status: authenticated ? "passed" : "failed",
    details: authenticated
      ? `Authenticated as ${tokens?.upn || (process.env.EAI_ACCESS_TOKEN ? "injected access token" : "user")}`
      : "Not authenticated. Run `eai login` or set EAI_ACCESS_TOKEN.",
  });

  try {
    const localTypes = await loadObjectTypes(context.root);
    const backendSummary = collectPublishedStorageBackends(localTypes);
    if (backendSummary.invalid.length > 0) {
      throw new Error(
        `Unsupported storageBackend value(s): ${backendSummary.invalid.join(", ")}. Use postgresql, documentdb, blob, or search.`,
      );
    }
    addCheck(checks, {
      id: "backend-config",
      label: "Local backend contract",
      method: "LOCAL",
      endpoint: "src/eai.config/object-types.ts",
      status: "passed",
      details:
        backendSummary.backends.length > 0
          ? `Published local backends: ${backendSummary.backends.join(", ")}`
          : "No explicit storageBackend declarations found; default PostgreSQL routing remains valid.",
    });
  } catch (err) {
    addCheck(checks, {
      id: "backend-config",
      label: "Local backend contract",
      method: "LOCAL",
      endpoint: "src/eai.config/object-types.ts",
      status: "failed",
      details: err instanceof Error ? err.message : String(err),
    });
  }

  if (!authenticated) {
    const skippedDueToAuth = [
      [
        "current-user",
        "Tenant membership contract",
        "GET",
        "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
      ],
      [
        "object-types",
        "Object Types list contract",
        "GET",
        "/v4/data/resources/object-types",
      ],
      ["schema", "Schema contract", "GET", "/v4/data/resources/schema/{tenantId}"],
    ] as const;

    for (const [id, label, method, endpoint] of skippedDueToAuth) {
      addCheck(checks, {
        id,
        label,
        method,
        endpoint,
        status: "skipped",
        details: "Skipped because authentication is required.",
      });
    }
  } else if (!context.tenantId || !client) {
    const skippedDueToTenant = [
      [
        "current-user",
        "Tenant membership contract",
        "GET",
        "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
      ],
      [
        "object-types",
        "Object Types list contract",
        "GET",
        "/v4/data/resources/object-types",
      ],
      ["schema", "Schema contract", "GET", "/v4/data/resources/schema/{tenantId}"],
    ] as const;

    for (const [id, label, method, endpoint] of skippedDueToTenant) {
      addCheck(checks, {
        id,
        label,
        method,
        endpoint,
        status: "skipped",
        details:
          "Skipped because no active tenant is selected. Run `eai tenant select`.",
      });
    }
  } else {
    try {
      const res = await systemClient.getUserMemberships(
        context.tenantId,
        tokens?.oid || "",
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await parseJsonBody(res);
      const tenantEntries = normalizeTenantEntries(payload);
      if (tenantEntries.length === 0) {
        throw new Error("Expected tenant membership entries in response");
      }
      addCheck(checks, {
        id: "current-user",
        label: "Tenant membership contract",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
        status: "passed",
        details: `Tenant entries: ${tenantEntries.length}`,
      });
    } catch (err) {
      addCheck(checks, {
        id: "current-user",
        label: "Tenant membership contract",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
        status: "failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const res = await client.getPublishedObjectTypes({ limit: 1 });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await parseJsonBody(res);
      if (!isRecord(payload) || !Array.isArray(payload.docs)) {
        throw new Error("Expected docs[] in Object Types response");
      }
      addCheck(checks, {
        id: "object-types",
        label: "Object Types list contract",
        method: "GET",
        endpoint: "/v4/data/resources/object-types",
        status: "passed",
        details: `Response includes docs[] (${payload.docs.length} item(s) in sample)`,
      });
      remoteObjectTypeCount = payload.docs.length;
    } catch (err) {
      addCheck(checks, {
        id: "object-types",
        label: "Object Types list contract",
        method: "GET",
        endpoint: "/v4/data/resources/object-types",
        status: "failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const res = await client.getSchema();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await parseJsonBody(res);
      const typeCount = extractSchemaTypeCount(payload);
      remoteObjectTypeCount = remoteObjectTypeCount ?? typeCount;
      if (
        typeCount === 0 &&
        (!isRecord(payload) || !Array.isArray(payload.docs))
      ) {
        throw new Error("Expected published Object Types in response");
      }
      addCheck(checks, {
        id: "schema",
        label: "Schema contract",
        method: "GET",
        endpoint: `/v4/data/resources/schema/${context.tenantId}`,
        status: "passed",
        details: `Published schema present (${typeCount} published type(s))`,
      });
    } catch (err) {
      addCheck(checks, {
        id: "schema",
        label: "Schema contract",
        method: "GET",
        endpoint: `/v4/data/resources/schema/${context.tenantId}`,
        status: "failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (authenticated && client && options.resourceType) {
    if (remoteObjectTypeCount === 0) {
      addCheck(checks, {
        id: "resource-list",
        label: "Resource list contract",
        method: "GET",
        endpoint: "/v4/data/resources/{tenantId}/{objectType}",
        status: "skipped",
        details:
          "Skipped because the active tenant has no published Object Types remotely.",
      });
      addCheck(checks, {
        id: "resource-query",
        label: "Resource query contract",
        method: "POST",
        endpoint: "/v4/data/resources/{tenantId}/query",
        status: "skipped",
        details:
          "Skipped because the active tenant has no published Object Types remotely.",
      });
      addCheck(checks, {
        id: "resource-cursor",
        label: "Resource cursor contract",
        method: "GET",
        endpoint: "/v4/data/resources/{tenantId}/{objectType}?cursor=...",
        status: "skipped",
        details:
          "Skipped because the active tenant has no published Object Types remotely.",
      });
      addCheck(checks, {
        id: "resource-aggregate",
        label: "Resource aggregate contract",
        method: "POST",
        endpoint: "/v4/data/resources/{tenantId}/{objectType}/aggregate",
        status: "skipped",
        details:
          "Skipped because the active tenant has no published Object Types remotely.",
      });
    } else {
      let resourceListPayload: Record<string, unknown> | null = null;

      try {
        const res = await client.listResources(options.resourceType, {
          limit: 1,
          page: 1,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await parseJsonBody(res);
        if (!isRecord(payload) || !Array.isArray(payload.docs)) {
          throw new Error("Expected docs[] in list response");
        }
        resourceListPayload = payload;
        addCheck(checks, {
          id: "resource-list",
          label: "Resource list contract",
          method: "GET",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}`,
          status: "passed",
          details: `docs[] present (${payload.docs.length} item(s) in sample)`,
        });
      } catch (err) {
        addCheck(checks, {
          id: "resource-list",
          label: "Resource list contract",
          method: "GET",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}`,
          status: "failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }

      const nextCursor =
        typeof resourceListPayload?.nextCursor === "string"
          ? resourceListPayload.nextCursor
          : null;
      if (!nextCursor) {
        addCheck(checks, {
          id: "resource-cursor",
          label: "Resource cursor contract",
          method: "GET",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}?cursor=...`,
          status: "skipped",
          details:
            "Skipped because the sample list response did not return a nextCursor.",
        });
      } else {
        try {
          const res = await client.listResources(options.resourceType, {
            limit: 1,
            cursor: nextCursor,
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const payload = await parseJsonBody(res);
          if (
            !isRecord(payload) ||
            (!("nextCursor" in payload) && !("docs" in payload))
          ) {
            throw new Error(
              "Expected docs[] and optional nextCursor in cursor list response",
            );
          }
          addCheck(checks, {
            id: "resource-cursor",
            label: "Resource cursor contract",
            method: "GET",
            endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}?cursor=...`,
            status: "passed",
            details: `Cursor-aware list response shape: ${describeShape(payload)}`,
          });
        } catch (err) {
          addCheck(checks, {
            id: "resource-cursor",
            label: "Resource cursor contract",
            method: "GET",
            endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}?cursor=...`,
            status: "failed",
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }

      try {
        const res = await client.queryResources({
          object_types: [options.resourceType],
          limit: 1,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await parseJsonBody(res);
        if (!isRecord(payload)) {
          throw new Error(
            `Expected object, received ${describeShape(payload)}`,
          );
        }
        addCheck(checks, {
          id: "resource-query",
          label: "Resource query contract",
          method: "POST",
          endpoint: `/v4/data/resources/${context.tenantId}/query`,
          status: "passed",
          details: describeShape(payload),
        });
      } catch (err) {
        addCheck(checks, {
          id: "resource-query",
          label: "Resource query contract",
          method: "POST",
          endpoint: `/v4/data/resources/${context.tenantId}/query`,
          status: "failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const res = await client.aggregateResources(options.resourceType, {
          groupBy: ["id"],
          metrics: {
            count: { function: "count" },
          },
          limit: 1,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await parseJsonBody(res);
        if (!isRecord(payload) || !Array.isArray(payload.rows)) {
          throw new Error("Expected rows[] in aggregate response");
        }
        addCheck(checks, {
          id: "resource-aggregate",
          label: "Resource aggregate contract",
          method: "POST",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}/aggregate`,
          status: "passed",
          details: `rows[] present (${payload.rows.length} row(s) in sample)`,
        });
      } catch (err) {
        addCheck(checks, {
          id: "resource-aggregate",
          label: "Resource aggregate contract",
          method: "POST",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}/aggregate`,
          status: "failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    addCheck(checks, {
      id: "resource-list",
      label: "Resource list contract",
      method: "GET",
      endpoint: "/v4/data/resources/{tenantId}/{objectType}",
      status: "skipped",
      details: "Provide --resource-type to exercise list/query contracts.",
    });
    addCheck(checks, {
      id: "resource-query",
      label: "Resource query contract",
      method: "POST",
      endpoint: "/v4/data/resources/{tenantId}/query",
      status: "skipped",
      details: "Provide --resource-type to exercise query contract.",
    });
    addCheck(checks, {
      id: "resource-cursor",
      label: "Resource cursor contract",
      method: "GET",
      endpoint: "/v4/data/resources/{tenantId}/{objectType}?cursor=...",
      status: "skipped",
      details: "Provide --resource-type to exercise cursor contract.",
    });
    addCheck(checks, {
      id: "resource-aggregate",
      label: "Resource aggregate contract",
      method: "POST",
      endpoint: "/v4/data/resources/{tenantId}/{objectType}/aggregate",
      status: "skipped",
      details: "Provide --resource-type to exercise aggregate contract.",
    });
  }

  if (authenticated && client && options.resourceType && options.resourceId) {
    if (remoteObjectTypeCount === 0) {
      addCheck(checks, {
        id: "resource-get",
        label: "Resource get contract",
        method: "GET",
        endpoint: "/v4/data/resources/{tenantId}/{objectType}/{id}",
        status: "skipped",
        details:
          "Skipped because the active tenant has no published Object Types remotely.",
      });
    } else {
      try {
        const res = await client.getResource(
          options.resourceType,
          options.resourceId,
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await parseJsonBody(res);
        if (
          !isRecord(payload) ||
          !("id" in payload) ||
          !("data" in payload) ||
          typeof payload.version !== "number"
        ) {
          throw new Error(
            "Expected id, data, and numeric version in resource payload",
          );
        }
        addCheck(checks, {
          id: "resource-get",
          label: "Resource get contract",
          method: "GET",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}/${options.resourceId}`,
          status: "passed",
          details: "Resource payload includes id, data, and version",
        });
      } catch (err) {
        addCheck(checks, {
          id: "resource-get",
          label: "Resource get contract",
          method: "GET",
          endpoint: `/v4/data/resources/${context.tenantId}/${options.resourceType}/${options.resourceId}`,
          status: "failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    addCheck(checks, {
      id: "resource-get",
      label: "Resource get contract",
      method: "GET",
      endpoint: "/v4/data/resources/{tenantId}/{objectType}/{id}",
      status: "skipped",
      details:
        "Provide both --resource-type and --resource-id to exercise get/update version contract.",
    });
  }

  if (authenticated && options.tenantRecordId) {
    try {
      const res = await systemClient.getUserMemberships(
        context.tenantId || options.tenantRecordId,
        tokens?.oid || "",
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await parseJsonBody(res);
      const tenantEntries = normalizeTenantEntries(payload);
      const tenant = tenantEntries.find(
        (entry) =>
          entry.tenant.id === options.tenantRecordId ||
          entry.tenant.slug === options.tenantRecordId,
      );
      if (!tenant) {
        throw new Error(
          "Requested tenant was not found in the current tenant-admin memberships",
        );
      }
      addCheck(checks, {
        id: "tenant-info",
        label: "Tenant info resolution",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
        status: "passed",
        details: `Resolved ${tenant.tenant.displayName} (${tenant.tenant.slug})`,
      });
    } catch (err) {
      addCheck(checks, {
        id: "tenant-info",
        label: "Tenant info resolution",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
        status: "failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    addCheck(checks, {
      id: "tenant-info",
      label: "Tenant info resolution",
      method: "GET",
      endpoint: "/v4/platform/tenants/{tenantId}/users/{oid}/memberships",
      status: "skipped",
      details: "Provide --tenant-record to exercise tenant info lookup.",
    });
  }

  if (authenticated && context.tenantId && options.userEmail) {
    try {
      const res = await systemClient.lookupUserByEmail(
        context.tenantId,
        options.userEmail,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await parseJsonBody(res);
      if (!isRecord(payload)) {
        throw new Error(`Expected object, received ${describeShape(payload)}`);
      }
      const userId =
        typeof payload.id === "string"
          ? payload.id
          : isRecord(payload.user) && typeof payload.user.id === "string"
            ? payload.user.id
            : null;
      if (!userId) {
        throw new Error(
          "Expected direct id or payload.user.id in lookup response",
        );
      }
      addCheck(checks, {
        id: "user-lookup",
        label: "User lookup contract",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/by-email?email=...",
        status: "passed",
        details: `${describeShape(payload)} (resolved user id ${userId})`,
      });
    } catch (err) {
      addCheck(checks, {
        id: "user-lookup",
        label: "User lookup contract",
        method: "GET",
        endpoint: "/v4/platform/tenants/{tenantId}/users/by-email?email=...",
        status: "failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    addCheck(checks, {
      id: "user-lookup",
      label: "User lookup contract",
      method: "GET",
      endpoint: "/v4/platform/tenants/{tenantId}/users/by-email?email=...",
      status: "skipped",
      details: "Provide --user-email to exercise user lookup.",
    });
  }

  if (authenticated && client && options.includeChat) {
    if (!workflowId) {
      addCheck(checks, {
        id: "chat-send",
        label: "Chat send contract",
        method: "POST",
        endpoint: "/v4/ai/chat/{tenantId}/{workflowId}/{stage}",
        status: "skipped",
        details: "Provide --workflow or WORKFLOW_*_ID to exercise chat.",
      });
    } else {
      try {
        const res = await client.sendChat(
          workflowId,
          stage,
          options.chatMessage || "Smoke test from `eai verify calls`",
          randomUUID(),
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await parseJsonBody(res);
        if (
          !isRecord(payload) ||
          (typeof payload.response !== "string" &&
            typeof payload.message !== "string")
        ) {
          throw new Error(
            "Expected response or message string in chat payload",
          );
        }
        addCheck(checks, {
          id: "chat-send",
          label: "Chat send contract",
          method: "POST",
          endpoint: `/v4/ai/chat/${context.tenantId}/${workflowId}/${stage}`,
          status: "passed",
          details: "Chat response payload includes response/message text",
        });
      } catch (err) {
        addCheck(checks, {
          id: "chat-send",
          label: "Chat send contract",
          method: "POST",
          endpoint: `/v4/ai/chat/${context.tenantId || "{tenantId}"}/${workflowId}/${stage}`,
          status: "failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    addCheck(checks, {
      id: "chat-send",
      label: "Chat send contract",
      method: "POST",
      endpoint: "/v4/ai/chat/{tenantId}/{workflowId}/{stage}",
      status: "skipped",
      details:
        "Opt in with --include-chat. This creates a conversation record.",
    });
  }

  const intentionallySkipped: Array<Omit<ContractCheckResult, "status">> = [
    {
      id: "resource-mutations",
      label: "Resource create/update/delete contracts",
      method: "POST/PUT/DELETE",
      endpoint: "/v4/data/resources/{tenantId}/{objectType}[/{id}]",
      details: "Not auto-executed because they mutate data.",
    },
    {
      id: "document-contracts",
      label: "Document upload/classify/index contracts",
      method: "POST",
      endpoint: "/v4/data/documents/*",
      details:
        "Not auto-executed because they upload files or trigger indexing.",
    },
    {
      id: "user-provisioning",
      label: "User provisioning contracts",
      method: "POST",
      endpoint: "/v4/identity/me/provision and /v4/platform/tenants/{tenantId}/users/{oid}/provision",
      details: "Not auto-executed because they change tenant membership.",
    },
    {
      id: "tenant-create",
      label: "Tenant create contract",
      method: "POST",
      endpoint: "/v4/platform/tenants",
      details: "Not auto-executed because it creates tenants.",
    },
    {
      id: "chat-stream",
      label: "Chat stream contract",
      method: "POST",
      endpoint: "/v4/ai/chat/stream/{tenantId}/{workflowId}/{stage}",
      details:
        "Not auto-executed because it requires streaming response handling.",
    },
  ];

  for (const check of intentionallySkipped) {
    addCheck(checks, {
      ...check,
      status: "skipped",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    publicApiUrl: context.publicApiUrl,
    tenantId: context.tenantId,
    workflowId,
    checks,
    summary: summarizeChecks(checks),
  };
}

export const verifyCommand = new Command("verify")
  .description("Run platform connectivity checks")
  .option(
    "--tenant-id <id>",
    "Run read-only connectivity checks against a specific tenant ID",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ eai verify
  $ eai verify --tenant-id <tenantId>
  $ eai verify calls --format json

Use 'eai verify' for a quick health check.
Use 'eai verify calls' when you need to inspect the exact API contracts the CLI depends on.
  `,
  )
  .action(async (options) => {
    let environment: VerifyEnvironment;
    try {
      environment = await loadVerifyEnvironment({
        tenantId: extractTenantIdOption(options),
      });
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const { root, publicApiUrl, tenantId } = environment;

    out.heading("Platform Connectivity Checks");
    out.blank();

    const client = new PlatformAPIClient(publicApiUrl, tenantId || "unknown");
    let passed = 0;
    let failed = 0;

    // Check 1: PublicAPI reachable
    const apiSpinner = ora("PublicAPI gateway").start();
    try {
      const start = Date.now();
      const res = await fetch(`${publicApiUrl}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - start;
      if (res.ok || res.status === 404) {
        // 404 is fine — means server is up, just no /health endpoint
        apiSpinner.succeed(`PublicAPI reachable (${latency}ms)`);
        passed++;
      } else {
        apiSpinner.fail(`PublicAPI returned ${res.status}`);
        failed++;
      }
    } catch (err) {
      apiSpinner.fail(
        `PublicAPI not reachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }

    // Check 2: Auth token
    const authSpinner = ora("Authentication").start();
    const authenticated = await isAuthenticated();
    if (authenticated) {
      const tokens = await loadTokens();
      authSpinner.succeed(`Authenticated as ${tokens?.upn || "user"}`);
      passed++;
    } else {
      authSpinner.warn("Not authenticated — run `eai login`");
      failed++;
    }

    // Check 3: Platform service connectivity
    if (authenticated && tenantId) {
      const cfgSpinner = ora("Platform service").start();
      try {
        const res = await client.getPublishedObjectTypes({ limit: 1 });
        if (res.ok) {
          cfgSpinner.succeed("Platform service reachable");
          passed++;
        } else {
          cfgSpinner.fail(`Platform service returned ${res.status}`);
          failed++;
        }
      } catch (err) {
        cfgSpinner.fail(
          `Platform service not reachable: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed++;
      }
    }

    // Check 4: Data service (schema)
    if (authenticated && tenantId) {
      const resSpinner = ora("Data service (schema)").start();
      try {
        const res = await client.getSchema();
        if (res.ok) {
          const schema = (await res.json()) as {
            objectTypes?: unknown[];
            object_types?: unknown[];
          };
          const typeCount = Array.isArray(schema?.object_types)
            ? schema.object_types.length
            : (schema?.objectTypes as unknown[])?.length || 0;
          resSpinner.succeed(
            `Data service reachable — ${typeCount} published types`,
          );
          passed++;
        } else {
          // Surface the server's reason code/message (e.g. RESOURCEAPI_INSTALL_REGISTRY_NO_MATCH)
          // instead of only the status — and add actionable guidance when we recognise it, so a
          // tenant-provisioning issue is not mistaken for a transient outage.
          let code: string | undefined;
          let message: string | undefined;
          try {
            const body = (await res.json()) as { code?: unknown; message?: unknown };
            if (typeof body?.code === "string") code = body.code;
            if (typeof body?.message === "string") message = body.message;
          } catch {
            // non-JSON body — the status alone is the signal
          }
          resSpinner.fail(
            `Data service returned ${res.status}${code ? ` [${code}]` : ""}${message ? ` — ${message}` : ""}`,
          );
          const guidance = findGuidance({
            status: res.status,
            serverCode: code,
            message: message ?? code,
          });
          if (guidance) {
            out.info(guidance.title);
            if (!guidance.retry.allowed && guidance.retry.stopWhen[0]) {
              out.info(guidance.retry.stopWhen[0]);
            }
          }
          failed++;
        }
      } catch (err) {
        resSpinner.fail(
          `Data service not reachable: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed++;
      }
    }

    // Check 5: Local Object Types
    const typesSpinner = ora("Local Object Types").start();
    try {
      const types = await loadObjectTypes(root);
      const totalTypes = Object.values(types).reduce(
        (sum, t) => sum + t.length,
        0,
      );
      const tenantKeys = Object.keys(types);
      typesSpinner.succeed(
        `${totalTypes} types across ${tenantKeys.length} tenant scope(s)`,
      );
      passed++;
    } catch (err) {
      typesSpinner.fail(
        `No Object Types found: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }

    // Summary
    out.blank();
    if (failed === 0) {
      out.success(`All ${passed} checks passed`);
    } else {
      out.warn(`${passed} passed, ${failed} failed`);
    }
  });

verifyCommand
  .command("storage")
  .description("Verify storage status and doctor contracts")
  .option("--tenant-id <id>", "Tenant ID to verify")
  .option("--format <format>", "Output format (text|json)", "text")
  .option("--json", "Output raw JSON (deprecated, use --format json)", false)
  .action(async (options) => {
    let context: VerifyEnvironment;
    try {
      context = await loadVerifyEnvironment({
        tenantId: extractTenantIdOption(options),
      });
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const client = new PlatformAPIClient(
      context.publicApiUrl,
      context.tenantId || "unknown",
    );
    const checks: Array<{
      id: string;
      status: "passed" | "failed";
      details: string;
      payload?: unknown;
    }> = [];

    const statusResponse = await client.getResourceStorageStatus();
    if (statusResponse.ok) {
      const payload = (await statusResponse.json()) as {
        objectTypes?: unknown[];
      };
      checks.push({
        id: "storage-status",
        status: "passed",
        details: `${payload.objectTypes?.length || 0} object type route(s) returned`,
        payload,
      });
    } else {
      checks.push({
        id: "storage-status",
        status: "failed",
        details: `${statusResponse.status} ${statusResponse.statusText}`,
      });
    }

    const doctorResponse = await client.getResourceStorageDoctor();
    if (doctorResponse.ok) {
      const payload = (await doctorResponse.json()) as { healthy?: boolean };
      checks.push({
        id: "storage-doctor",
        status: payload.healthy ? "passed" : "failed",
        details: payload.healthy
          ? "Storage doctor healthy"
          : "Storage doctor reported issues",
        payload,
      });
    } else {
      checks.push({
        id: "storage-doctor",
        status: "failed",
        details: `${doctorResponse.status} ${doctorResponse.statusText}`,
      });
    }

    const failed = checks.filter((check) => check.status === "failed").length;
    const report = {
      generatedAt: new Date().toISOString(),
      publicApiUrl: context.publicApiUrl,
      tenantId: context.tenantId,
      checks,
      summary: { passed: checks.length - failed, failed, skipped: 0 },
    };

    if (options.json || options.format === "json") {
      out.json(report);
      return;
    }

    out.heading("Storage Verification");
    for (const check of checks) {
      if (check.status === "passed") {
        out.success(`${check.id}: ${check.details}`);
      } else {
        out.error(`${check.id}: ${check.details}`);
      }
    }

    if (failed > 0) {
      process.exit(1);
    }
  });

verifyCommand
  .command("calls")
  .description("Audit platform-facing API call contracts used by the CLI")
  .option(
    "--tenant-id <id>",
    "Tenant ID to use for read-only resource and schema checks",
  )
  .option(
    "--resource-type <type>",
    "Resource type to probe with list/query/get checks",
  )
  .option(
    "--resource-id <id>",
    "Specific resource ID to fetch during contract audit",
  )
  .option("--workflow <id>", "Workflow ID to use for chat smoke test")
  .option(
    "--stage <stage>",
    "Chat stage to use when --include-chat is enabled",
    "chat",
  )
  .option(
    "--tenant-record <id>",
    "Tenant record ID to use for tenant info lookup",
  )
  .option(
    "--user-email <email>",
    "Email address to use for user lookup contract check",
  )
  .option(
    "--include-chat",
    "Execute a non-streaming chat request (creates a conversation)",
    false,
  )
  .option(
    "--chat-message <message>",
    "Message to send when probing chat",
    "Smoke test from `eai verify calls`",
  )
  .option("--format <format>", "Output format (text|json)", "text")
  .option("--json", "Output raw JSON (deprecated, use --format json)", false)
  .action(async (options) => {
    if (options.json) {
      options.format = "json";
    }

    let report: ContractAuditReport;
    try {
      report = await runContractAudit({
        tenantId: extractTenantIdOption(options),
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        workflowId: options.workflow,
        stage: options.stage,
        tenantRecordId: options.tenantRecord,
        userEmail: options.userEmail,
        includeChat: options.includeChat,
        chatMessage: options.chatMessage,
      });
    } catch (err) {
      out.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (options.format === "json") {
      out.json(report);
      return;
    }

    renderContractAudit(report);
    if (report.summary.failed > 0) {
      process.exit(1);
    }
  });

// ─── eai doctor ────────────────────────────────────────────────────────────

function describeReleaseChannel(channel: "npmjs" | "static-registry"): string {
  if (channel === "npmjs") {
    return "npmjs";
  }
  return "static registry fallback";
}

function describeTemplateSnapshot(template: {
  readonly displaySource?: string;
  readonly repo?: string;
  readonly commit?: string;
}): string {
  if (template.displaySource) {
    return template.displaySource;
  }

  if (template.commit && template.repo) {
    return `${template.repo}@${template.commit.slice(0, 7)}`;
  }

  return template.repo || "unknown";
}

async function hasTemplateDemoHomeFallback(projectRoot: string): Promise<boolean> {
  const homeClientPath = join(projectRoot, "src", "app", "home-client.tsx");
  try {
    const source = await readFile(homeClientPath, "utf-8");
    return (
      source.includes("@enterpriseaigroup/demo") &&
      source.includes("<DemoPage")
    );
  } catch {
    return false;
  }
}

async function renderDoctorUpdateStatus(root: string): Promise<void> {
  out.blank();
  out.heading("Update Status");
  out.blank();

  const currentCliVersion = pkg.version;
  out.success(`Installed CLI version: ${chalk.dim(currentCliVersion)}`);

  const latestRelease = await fetchLatestRelease();
  if (!latestRelease) {
    out.warn(
      "Could not determine the latest published CLI release from npmjs or the EAI static registry fallback right now.",
    );
  } else if (compareVersions(latestRelease.version, currentCliVersion) > 0) {
    out.warn(
      `Published CLI available: ${latestRelease.version} ${chalk.dim(`(${describeReleaseChannel(latestRelease.channel)})`)}`,
    );
    out.dim(`  Run: ${chalk.cyan("eai update")}`);
  } else {
    out.success(
      `Published CLI channel is current: ${latestRelease.version} ${chalk.dim(`(${describeReleaseChannel(latestRelease.channel)})`)}`,
    );
  }

  const resolvedManifest = await resolveProjectManifest(root);
  const demoHomeFallbackDetected = await hasTemplateDemoHomeFallback(root);
  const manifest = resolvedManifest.manifest;
  if (!manifest) {
    out.info(
      "No `.eai-manifest.json` found yet. Run `eai gofer refresh --check` once to adopt the current Gofer-managed asset snapshot safely.",
    );
    out.info(
      "Template and UI component drift is not auto-merged yet; use `eai template check` before copying changes manually.",
    );
    if (demoHomeFallbackDetected) {
      out.warn(
        "Detected template demo fallback in src/app/home-client.tsx. Confirm this is intentional for this app.",
      );
      out.info(
        "If this app should render a product-specific home page, restore your local home-client wiring before deploy.",
      );
    }
    return;
  }

  if (resolvedManifest.source === "inferred-init-commit") {
    out.info(
      "Using template provenance inferred from the original `eai init` scaffold commit because this project does not yet record template provenance in `.eai-manifest.json`.",
    );
  } else if (resolvedManifest.source === "inferred-project-structure") {
    out.info(
      "Using template provenance inferred from this legacy EAI scaffold because this project does not yet record template provenance in `.eai-manifest.json`.",
    );
  }

  if (manifest.cli?.version) {
    if (manifest.cli.version === currentCliVersion) {
      out.success(`Project manifest CLI snapshot: ${manifest.cli.version}`);
    } else {
      out.info(
        `Project manifest CLI snapshot: ${manifest.cli.version} ${chalk.dim(`(current CLI: ${currentCliVersion})`)}`,
      );
    }
  } else {
    out.info("Project manifest does not yet record a CLI snapshot.");
  }

  if (manifest.gofer) {
    const bundledGofer = await readGoferBundleMetadata();
    const projectLabel =
      manifest.gofer.bundle?.describe ||
      manifest.gofer.bundle?.commit ||
      "unknown";
    const bundledLabel =
      bundledGofer.describe || bundledGofer.commit || "unknown";
    if (
      bundledGofer.commit &&
      manifest.gofer.bundle?.commit &&
      bundledGofer.commit !== manifest.gofer.bundle.commit
    ) {
      out.warn(
        `Available Gofer assets differ from this project: ${projectLabel} -> ${bundledLabel}`,
      );
      out.dim(`  Preview: ${chalk.cyan("eai gofer refresh --check")}`);
    } else {
      out.success(`Gofer-managed asset snapshot: ${projectLabel}`);
    }
  } else {
    out.info(
      "Gofer-managed assets are not tracked yet. Run `eai gofer refresh --check` to preview a safe refresh.",
    );
  }

  if (!manifest.template) {
    out.info("Template provenance is not recorded for this project.");
    return;
  }

  const bundledTemplate = resolveTemplateClonePlan(DEFAULT_TEMPLATE_SOURCE);
  const projectTemplateLabel = describeTemplateSnapshot(manifest.template);
  const bundledTemplateLabel = describeTemplateSnapshot({
    repo: bundledTemplate.cloneSource,
    commit: bundledTemplate.pinnedCommit,
    displaySource: bundledTemplate.displaySource,
  });

  if (
    manifest.template.repo &&
    !isDefaultTemplateSource(manifest.template.repo) &&
    manifest.template.repo !== bundledTemplate.cloneSource
  ) {
    out.info(`Project template source: ${projectTemplateLabel}`);
    out.info(`Current bundled default template: ${bundledTemplateLabel}`);
    out.info(
      "This project was initialized from a different template source, so template or UI updates still need manual review.",
    );
    out.dim(`  Preview: ${chalk.cyan("eai template check")}`);
    return;
  }

  if (
    manifest.template.commit &&
    bundledTemplate.pinnedCommit &&
    manifest.template.commit !== bundledTemplate.pinnedCommit
  ) {
    out.warn(
      `Bundled default template has changed since init: ${projectTemplateLabel} → ${bundledTemplateLabel}`,
    );
    out.info(
      "The CLI does not auto-merge template or UI component updates into existing repos yet. Review `eai template check` before applying those changes manually.",
    );
    if (demoHomeFallbackDetected) {
      out.warn(
        "Detected template demo fallback in src/app/home-client.tsx while template drift is present.",
      );
      out.info(
        "Keep your app-specific home-client wiring unless you intentionally want the demo landing page.",
      );
    }
    return;
  }

  out.success(`Template snapshot: ${projectTemplateLabel}`);
  if (demoHomeFallbackDetected) {
    out.warn(
      "Detected template demo fallback in src/app/home-client.tsx. Confirm this is intentional for this app.",
    );
  }
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose common issues and suggest fixes")
  .option("--fix", "Attempt to fix issues automatically", false)
  .option(
    "--check-updates",
    "Report CLI release status plus Gofer/template drift for the current project",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  $ eai doctor
  $ eai doctor --check-updates

Notes:
  - \`eai update\` upgrades the installed CLI package only.
  - \`eai gofer refresh --check\` previews safe repo-local Gofer asset updates.
  - \`eai template check\` previews app-template and UI drift without writing files.
  - Template and UI component changes are not auto-merged into existing repos yet.
  `,
  )
  .action(async (options: { fix?: boolean; checkUpdates?: boolean }) => {
    const issues: Array<{
      severity: "error" | "warn" | "info";
      message: string;
      fix?: string;
    }> = [];

    out.heading("EAI Platform Health Check");
    out.blank();

    // 1. Project detection
    const root = await findProjectRoot();
    if (!root) {
      out.error("Not in an EAI project directory.");
      exitWithError(ErrorCode.E001);
    }
    out.success(`Project root: ${chalk.dim(root)}`);

    // 2. Local app env file (optional for CLI platform operations)
    try {
      await access(join(root, ".env.local"));
      out.success(".env.local found for local app runtime");
    } catch {
      out.info(
        ".env.local not found — CLI auth and tenant selection use stored login context",
      );
    }

    // 3. PublicAPI resolution
    const envVars = await loadEnvFile(root);
    const publicApiUrl = await resolvePublicApiUrl(root);
    const publicApiSource =
      envVars.BASE_URL_PUBLIC_API || process.env.BASE_URL_PUBLIC_API
        ? "environment"
        : "stored login/default";
    out.success(
      `PublicAPI URL resolved (${publicApiSource}): ${chalk.dim(publicApiUrl)}`,
    );

    // 4. Auth status
    const authenticated = await isAuthenticated();
    if (authenticated) {
      const tokens = await loadTokens();
      out.success(`Authenticated as ${tokens?.upn || "user"}`);
    } else {
      issues.push({
        severity: "warn",
        message: "Not authenticated",
        fix: "Run `eai login` to authenticate with Entra CIAM",
      });
      out.warn("Not authenticated");
    }

    // 5. Active tenant selection
    if (authenticated) {
      try {
        const tenantContext = await resolveActiveTenantContext({
          projectRoot: root,
          publicApiUrl,
          interactive: false,
        });
        out.success(
          `Active tenant selected: ${tenantContext.activeTenant.displayName} ${chalk.dim(`(${tenantContext.activeTenant.id})`)}`,
        );
      } catch (err) {
        issues.push({
          severity: "warn",
          message: err instanceof Error ? err.message : String(err),
          fix: "Run `eai tenant list` to inspect memberships, then `eai tenant select` to choose one",
        });
        out.warn(err instanceof Error ? err.message : String(err));
      }
    }

    // 6. Object types loadable
    try {
      const types = await loadObjectTypes(root);
      const totalTypes = Object.values(types).reduce(
        (sum, t) => sum + t.length,
        0,
      );
      out.success(`Object Types: ${totalTypes} defined`);
    } catch (err) {
      issues.push({
        severity: "warn",
        message: `Object Types not loadable: ${err instanceof Error ? err.message : String(err)}`,
        fix: "Check src/eai.config/object-types.ts for syntax errors",
      });
      out.warn("Object Types not loadable");
    }

    // 7. Deployment workflow exists
    try {
      await access(join(root, ".github", "workflows", "deploy-demo.yml"));
      out.success("Deployment workflow exists");
    } catch {
      issues.push({
        severity: "warn",
        message: "deploy-demo.yml not found",
        fix: "Run `eai deploy setup` to generate the workflow",
      });
      out.warn("deploy-demo.yml not found");
    }

    // 8. node_modules exists
    try {
      await access(join(root, "node_modules"));
      out.success("Dependencies installed");
    } catch {
      issues.push({
        severity: "error",
        message: "node_modules not found",
        fix: "Run `npm install`",
      });
      out.error("Dependencies not installed");
    }

    // 9. Platform SDK available
    try {
      await access(join(root, "packages", "platform-sdk"));
      out.success("Platform SDK present");
    } catch {
      try {
        await access(
          join(root, "node_modules", "@enterpriseaigroup", "platform-sdk"),
        );
        out.success("Platform SDK installed");
      } catch {
        try {
          await access(
            join(root, "node_modules", "@eai-tools", "platform-sdk"),
          );
          out.success("Legacy Platform SDK installed");
        } catch {
          issues.push({
            severity: "warn",
            message: "Platform SDK not found",
            fix: "Restore local packages/platform-sdk; the shared package is not promoted yet.",
          });
          out.warn("Platform SDK not found");
        }
      }
    }

    if (options.checkUpdates) {
      await renderDoctorUpdateStatus(root);
    }

    // Summary
    out.blank();
    if (issues.length === 0) {
      out.success("No issues found. Your project is healthy!");
    } else {
      out.heading(`${issues.length} issue(s) found`);
      out.blank();
      for (const issue of issues) {
        const icon =
          issue.severity === "error"
            ? out.symbols.error
            : issue.severity === "warn"
              ? out.symbols.warning
              : out.symbols.info;
        out.info(`${icon} ${issue.message}`);
        if (issue.fix) {
          out.dim(`  Fix: ${issue.fix}`);
        }
      }
    }
  });
