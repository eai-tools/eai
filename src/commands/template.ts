import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import chalk from "chalk";
import { findProjectRoot } from "../lib/config.js";
import { scanAppRouterRouteExports } from "../lib/next-route-exports.js";
import {
  resolveProjectManifest,
  type ProjectManifestSource,
} from "../lib/project-manifest.js";
import * as out from "../lib/output.js";
import { ErrorCode, exitWithError } from "../lib/error-codes.js";
import {
  describeCloneFailure,
  isDefaultTemplateSource,
  resolveTemplateClonePlan,
} from "./init.js";

const exec = promisify(execFile);
const DEFAULT_TEMPLATE_SOURCE =
  "https://github.com/eai-support/eai-app-template.git";
const IGNORE_EXACT_PATHS = new Set([
  ".eai-manifest.json",
  ".env.local",
  ".github/workflows/deploy-demo.yml",
  "CLAUDE.md",
  "package.json",
  "src/eai.config/object-types.ts",
]);
const IGNORE_PREFIXES = [
  ".agents/",
  ".claude/",
  ".gemini/",
  ".specify/",
  ".system/",
  ".github/copilot-instructions.md",
  ".github/instructions/",
  ".github/prompts/",
  ".github/skills/",
];
const HIGH_RISK_TEMPLATE_PATHS = new Set(["src/app/home-client.tsx"]);

type TemplateCheckAction = "add" | "review";
type TemplateCheckCategory = "ui" | "general";

interface TemplateCheckItem {
  readonly relativePath: string;
  readonly action: TemplateCheckAction;
  readonly category: TemplateCheckCategory;
}

interface TemplateCheckPlan {
  readonly manifestSource: ProjectManifestSource;
  readonly sourceLabel: string;
  readonly usesBundledDefault: boolean;
  readonly projectTemplateLabel: string;
  readonly currentTemplateLabel: string;
  readonly items: readonly TemplateCheckItem[];
  readonly routeExportViolations: readonly {
    readonly routeFile: string;
    readonly invalidExports: readonly string[];
  }[];
  readonly objectTypeNormalizationWarnings: readonly ObjectTypeNormalizationWarning[];
  readonly summary: TemplateCheckSummary;
}

interface TemplateCheckSummary {
  readonly add: number;
  readonly review: number;
  readonly ui: number;
  readonly unchanged: number;
}

interface ObjectTypeNormalizationWarning {
  readonly relativePath: string;
  readonly kind: "custom-slug-logic" | "direct-resource-route";
  readonly message: string;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hashContents(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isUiPath(relativePath: string): boolean {
  return (
    /^components\//.test(relativePath) ||
    /^app\//.test(relativePath) ||
    /^src\/components\//.test(relativePath) ||
    /^src\/app\//.test(relativePath)
  );
}

function shouldIgnoreTemplatePath(relativePath: string): boolean {
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    return true;
  }

  if (IGNORE_EXACT_PATHS.has(relativePath)) {
    return true;
  }

  return IGNORE_PREFIXES.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(prefix),
  );
}

function isHighRiskTemplatePath(relativePath: string): boolean {
  return HIGH_RISK_TEMPLATE_PATHS.has(relativePath);
}

function shouldAuditObjectTypeNormalization(relativePath: string): boolean {
  return (
    /^src\/.+\.(?:ts|tsx|js|jsx)$/.test(relativePath) ||
    /^packages\/[^/]+\/src\/.+\.(?:ts|tsx|js|jsx)$/.test(relativePath)
  );
}

function isKnownCanonicalObjectTypeHelper(relativePath: string): boolean {
  return (
    relativePath === "packages/platform-sdk/src/object-types.ts" ||
    relativePath === "src/lib/platform/object-types.ts"
  );
}

function mayUseDirectResourceRoutes(relativePath: string): boolean {
  return (
    relativePath === "packages/platform-sdk/src/modules/resources.ts" ||
    relativePath === "src/app/api/eai/[[...rest]]/route.ts" ||
    relativePath === "src/lib/platform/publicapi-route-family.ts"
  );
}

async function scanObjectTypeNormalizationWarnings(
  projectRoot: string,
): Promise<ObjectTypeNormalizationWarning[]> {
  const warnings: ObjectTypeNormalizationWarning[] = [];

  for (const relativePath of await collectFiles(projectRoot)) {
    if (!shouldAuditObjectTypeNormalization(relativePath)) {
      continue;
    }

    const source = await readFile(join(projectRoot, relativePath), "utf-8");

    if (
      !isKnownCanonicalObjectTypeHelper(relativePath) &&
      (/function\s+(?:toObjectTypeSlug|objectTypeSlug|slugifyObjectType)\b/.test(
        source,
      ) ||
        /(?:const|let|var)\s+(?:toObjectTypeSlug|objectTypeSlug|slugifyObjectType)\b/.test(
          source,
        ) ||
        source.includes(".replace(/([a-z0-9])([A-Z])/g, '$1-$2')"))
    ) {
      warnings.push({
        relativePath,
        kind: "custom-slug-logic",
        message:
          "Custom object-type slug normalization found outside the shared helper. Reuse the canonical helper so PascalCase names and kebab-case route slugs stay aligned.",
      });
    }

    if (
      !mayUseDirectResourceRoutes(relativePath) &&
      source.includes("/v4/data/resources")
    ) {
      warnings.push({
        relativePath,
        kind: "direct-resource-route",
        message:
          "Direct v4 data resource route usage found outside the approved SDK/BFF files. Use the shared platform SDK or useResources hook instead of hand-writing object-type paths.",
      });
    }
  }

  return warnings.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function collectFiles(root: string, baseRoot = root): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    const relativePath = normalizeRelativePath(
      relative(baseRoot, absolutePath),
    );

    if (shouldIgnoreTemplatePath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await collectFiles(absolutePath, baseRoot)));
      continue;
    }

    if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

async function cloneTemplateSnapshot(
  templateSource: string,
  targetDir: string,
): Promise<void> {
  const plan = resolveTemplateClonePlan(templateSource);

  if (!plan.pinnedCommit) {
    await exec("git", ["clone", "--depth", "1", plan.cloneSource, targetDir]);
    return;
  }

  try {
    await exec("git", ["init", targetDir]);
    await exec("git", [
      "-C",
      targetDir,
      "remote",
      "add",
      "origin",
      plan.cloneSource,
    ]);
    await exec("git", [
      "-C",
      targetDir,
      "fetch",
      "--depth",
      "1",
      "origin",
      plan.pinnedCommit,
    ]);
    await exec("git", ["-C", targetDir, "checkout", "FETCH_HEAD"]);
  } catch {
    await rm(targetDir, { recursive: true, force: true });
    await exec("git", ["clone", plan.cloneSource, targetDir]);
    await exec("git", ["-C", targetDir, "checkout", plan.pinnedCommit]);
  }
}

async function planTemplateCheck(
  projectRoot: string,
): Promise<
  | TemplateCheckPlan
  | {
      readonly skipped: string;
      readonly projectTemplateLabel: string;
      readonly currentTemplateLabel: string;
      readonly routeExportViolations: readonly {
        readonly routeFile: string;
        readonly invalidExports: readonly string[];
      }[];
      readonly objectTypeNormalizationWarnings: readonly ObjectTypeNormalizationWarning[];
    }
> {
  const resolvedManifest = await resolveProjectManifest(projectRoot);
  const routeExportViolations = await scanAppRouterRouteExports(projectRoot);
  const objectTypeNormalizationWarnings =
    await scanObjectTypeNormalizationWarnings(projectRoot);
  const manifest = resolvedManifest.manifest;
  if (!manifest?.template) {
    out.error("This project does not record template provenance yet.");
    out.info(
      "Run `eai gofer refresh --check` once to adopt the current project snapshot, or add `.eai-manifest.json` from a freshly initialized project before checking template drift.",
    );
    process.exit(1);
  }

  const bundledTemplate = resolveTemplateClonePlan(DEFAULT_TEMPLATE_SOURCE);
  const currentTemplateLabel = describeTemplateSnapshot({
    repo: bundledTemplate.cloneSource,
    commit: bundledTemplate.pinnedCommit,
    displaySource: bundledTemplate.displaySource,
  });
  const projectTemplateLabel = describeTemplateSnapshot(manifest.template);
  const usesBundledDefault = Boolean(
    manifest.template.repo &&
    (isDefaultTemplateSource(manifest.template.repo) ||
      manifest.template.repo === bundledTemplate.cloneSource),
  );

  if (
    usesBundledDefault &&
    manifest.template.commit &&
    bundledTemplate.pinnedCommit &&
    manifest.template.commit === bundledTemplate.pinnedCommit
  ) {
    return {
        skipped: "Bundled default template commit matches this project snapshot.",
        projectTemplateLabel,
        currentTemplateLabel,
        routeExportViolations,
        objectTypeNormalizationWarnings,
      };
  }

  const sourceToCheck = usesBundledDefault
    ? DEFAULT_TEMPLATE_SOURCE
    : manifest.template.repo || DEFAULT_TEMPLATE_SOURCE;
  const sourcePlan = resolveTemplateClonePlan(sourceToCheck);
  const sourceLabel = describeTemplateSnapshot({
    repo: sourcePlan.cloneSource,
    commit: sourcePlan.pinnedCommit,
    displaySource: sourcePlan.displaySource,
  });

  const tempRoot = await mkdtemp(join(tmpdir(), "eai-template-check-"));
  const templateRoot = join(tempRoot, "template");

  try {
    await cloneTemplateSnapshot(sourceToCheck, templateRoot);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    out.error(describeCloneFailure(sourceToCheck, error));
    process.exit(1);
  }

  try {
    const items: TemplateCheckItem[] = [];
    let unchanged = 0;

    for (const relativePath of await collectFiles(templateRoot)) {
      const desiredPath = join(templateRoot, relativePath);
      const currentPath = join(projectRoot, relativePath);
      const category: TemplateCheckCategory = isUiPath(relativePath)
        ? "ui"
        : "general";

      if (!(await fileExists(currentPath))) {
        items.push({
          relativePath,
          action: "add",
          category,
        });
        continue;
      }

      const [desiredContents, currentContents] = await Promise.all([
        readFile(desiredPath),
        readFile(currentPath),
      ]);

      if (hashContents(desiredContents) === hashContents(currentContents)) {
        unchanged += 1;
        continue;
      }

      items.push({
        relativePath,
        action: "review",
        category,
      });
    }

    const summary = items.reduce<{
      add: number;
      review: number;
      ui: number;
      unchanged: number;
    }>(
      (next, item) => {
        if (item.action === "add") {
          next.add += 1;
        } else {
          next.review += 1;
        }

        if (item.category === "ui") {
          next.ui += 1;
        }

        return next;
      },
      {
        add: 0,
        review: 0,
        ui: 0,
        unchanged,
      },
    );

    return {
      manifestSource: resolvedManifest.source,
      sourceLabel,
      usesBundledDefault,
      projectTemplateLabel,
      currentTemplateLabel,
      items,
      routeExportViolations,
      objectTypeNormalizationWarnings,
      summary,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function renderAction(action: TemplateCheckAction): string {
  return action === "add"
    ? `${out.symbols.added} add`
    : `${out.symbols.changed} review`;
}

function describeManifestSourceNote(
  source: ProjectManifestSource,
): string | null {
  switch (source) {
    case "inferred-init-commit":
      return "Template provenance was inferred from the original `eai init` scaffold commit because this project does not yet record template provenance in `.eai-manifest.json`.";
    case "inferred-project-structure":
      return "Template provenance was inferred from this legacy EAI scaffold because this project does not yet record template provenance in `.eai-manifest.json`.";
    default:
      return null;
  }
}

export const templateCommand = new Command("template").description(
  "Preview application template and UI component drift for the current project",
);

templateCommand
  .command("check")
  .description(
    "Preview file-level template/UI drift without writing to the repo",
  )
  .option("--format <format>", "Output format (text|json)", "text")
  .addHelpText(
    "after",
    `
Typical workflow:
  eai doctor --check-updates
  eai template check

Notes:
  - This command never writes files to your repo.
  - Template/UI updates still require manual review and selective copy/diff.
  - Use \`eai gofer refresh --check\` separately for Gofer-managed assets.
  `,
  )
  .action(async (options: { format?: string }) => {
    const root = await findProjectRoot();
    if (!root) {
      exitWithError(ErrorCode.E001);
    }

    const plan = await planTemplateCheck(root);
    if ("skipped" in plan) {
      if (options.format === "json") {
      out.json({
        mode: "check",
        projectRoot: root,
        status: "current",
        projectTemplate: plan.projectTemplateLabel,
        currentTemplate: plan.currentTemplateLabel,
        routeExportViolations: plan.routeExportViolations,
        objectTypeNormalizationWarnings: plan.objectTypeNormalizationWarnings,
        message: plan.skipped,
      });
      return;
      }

      out.heading("Template Check");
      out.blank();
      out.success(`Project root: ${chalk.dim(root)}`);
      out.success(`Project template: ${plan.projectTemplateLabel}`);
      out.success(`Current bundled template: ${plan.currentTemplateLabel}`);
      out.blank();
      out.success(plan.skipped);
      out.info(
        "No newer bundled app-template/UI snapshot is available in this installed CLI.",
      );
      out.info(
        "After your next CLI update, run `eai template check` again to preview file-level drift.",
      );
      if (plan.routeExportViolations.length > 0) {
        out.blank();
        out.warn("App Router route export audit found unsupported exports:");
        for (const violation of plan.routeExportViolations) {
          out.warn(
            `${violation.routeFile}: ${violation.invalidExports.join(", ")}`,
          );
        }
        out.info(
          "Move reusable helpers, dependency interfaces, and test seams into a sibling `handler.ts` or a lib module.",
        );
      }
      if (plan.objectTypeNormalizationWarnings.length > 0) {
        out.blank();
        out.warn("Object-type normalization audit found identifier drift risks:");
        for (const warning of plan.objectTypeNormalizationWarnings) {
          out.warn(`${warning.relativePath}: ${warning.message}`);
        }
      }
      return;
    }

    if (options.format === "json") {
      out.json({
        mode: "check",
        projectRoot: root,
        template: {
          project: plan.projectTemplateLabel,
          current: plan.currentTemplateLabel,
          source: plan.sourceLabel,
          usesBundledDefault: plan.usesBundledDefault,
          manifestSource: plan.manifestSource,
        },
        routeExportViolations: plan.routeExportViolations,
        objectTypeNormalizationWarnings: plan.objectTypeNormalizationWarnings,
        summary: plan.summary,
        items: plan.items,
      });
      return;
    }

    out.heading("Template Check");
    out.blank();
    out.success(`Project root: ${chalk.dim(root)}`);
    out.success(`Project template: ${plan.projectTemplateLabel}`);
    out.success(`Current comparison source: ${plan.sourceLabel}`);
    const manifestSourceNote = describeManifestSourceNote(plan.manifestSource);
    if (manifestSourceNote) {
      out.info(manifestSourceNote);
    }
    out.info(
      "This preview does not write files. Review changes before copying any template or UI updates into your repo.",
    );

    if (plan.routeExportViolations.length > 0) {
      out.blank();
      out.warn("App Router route export audit found unsupported exports:");
      for (const violation of plan.routeExportViolations) {
        out.warn(
          `${violation.routeFile}: ${violation.invalidExports.join(", ")}`,
        );
      }
      out.info(
        "Move reusable helpers, dependency interfaces, and test seams into a sibling `handler.ts` or a lib module.",
      );
    }

    if (plan.objectTypeNormalizationWarnings.length > 0) {
      out.blank();
      out.warn("Object-type normalization audit found identifier drift risks:");
      for (const warning of plan.objectTypeNormalizationWarnings) {
        out.warn(`${warning.relativePath}: ${warning.message}`);
      }
      out.info(
        "Keep PascalCase object type names in app code and let the shared SDK helper normalize route slugs. Avoid hand-written `/v4/data/resources/...` paths in feature code.",
      );
    }

    if (plan.items.length === 0) {
      out.blank();
      out.success(
        "No file-level drift detected against the current template snapshot.",
      );
      return;
    }

    out.blank();
    for (const item of plan.items) {
      const label =
        item.category === "ui" ? chalk.magenta("ui") : chalk.dim("file");
      const entrypointTag = isHighRiskTemplatePath(item.relativePath)
        ? ` ${chalk.yellow("[entrypoint]")}`
        : "";
      console.log(
        `  ${renderAction(item.action)}  ${item.relativePath} ${chalk.dim(`[${label}]`)}${entrypointTag}`,
      );
    }

    out.blank();
    out.table([
      ["Additions to consider", String(plan.summary.add)],
      ["Files needing manual review", String(plan.summary.review)],
      ["UI files in review set", String(plan.summary.ui)],
      ["Unchanged matches", String(plan.summary.unchanged)],
    ]);
    if (plan.items.some((item) => isHighRiskTemplatePath(item.relativePath))) {
      out.blank();
      out.warn(
        "High-risk entrypoint detected: src/app/home-client.tsx controls the root app experience.",
      );
      out.info(
        "Keep your app-specific home wiring unless you intentionally want to restore the template demo landing page.",
      );
    }
    out.blank();
    out.info("Recommended update flow:");
    out.info(
      `1. Review this preview with ${chalk.cyan("eai template check")}.`,
    );
    out.info(
      `2. Generate a fresh scaffold or clone snapshot from ${chalk.cyan(plan.sourceLabel)}.`,
    );
    out.info(
      "3. Copy additions first, then diff/review existing files that show `review`, especially UI paths under `src/app` and `src/components`.",
    );
  });
