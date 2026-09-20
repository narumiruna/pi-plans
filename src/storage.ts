import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

export interface PlanSummary {
  name: string
  modifiedAt: Date
  size: number
}

export class PlanConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanConflictError"
  }
}

export function normalizePlanName(rawName: string): string {
  let name = rawName.trim().normalize("NFKC")
  if (name.startsWith("@")) name = name.slice(1)
  if (!name.toLowerCase().endsWith(".md")) name += ".md"

  if (
    name.length === 0 ||
    name !== basename(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Plan names must reject ASCII control characters.
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name === ".md" ||
    Buffer.byteLength(name, "utf8") > 240
  ) {
    throw new Error(
      "Plan name must be a safe Markdown filename without directories or control characters.",
    )
  }

  return name
}

export function planPath(root: string, rawName: string): string {
  return join(root, normalizePlanName(rawName))
}

export function suggestedPlanName(title: string, now = new Date()): string {
  const slug = title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "")
  const date = now.toISOString().slice(0, 10)
  return `${date}_${slug || "plan"}-plan.md`
}

export async function ensurePlanDirectory(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stats = await lstat(root)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Plan storage must be a real directory: ${root}`)
  }
}

export async function listPlans(root: string): Promise<PlanSummary[]> {
  await ensurePlanDirectory(root)
  const entries = await readdir(root, { withFileTypes: true })
  const plans = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry): Promise<PlanSummary> => {
        const stats = await lstat(join(root, entry.name))
        return { name: entry.name, modifiedAt: stats.mtime, size: stats.size }
      }),
  )
  return plans.sort(
    (left, right) =>
      right.modifiedAt.getTime() - left.modifiedAt.getTime() || left.name.localeCompare(right.name),
  )
}

export async function uniquePlanName(
  root: string,
  title: string,
  now = new Date(),
): Promise<string> {
  const candidate = suggestedPlanName(title, now)
  const existing = new Set((await listPlans(root)).map((plan) => plan.name))
  if (!existing.has(candidate)) return candidate

  const stem = candidate.slice(0, -3)
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const next = `${stem}-${suffix}.md`
    if (!existing.has(next)) return next
  }
  throw new Error("Could not allocate a unique plan filename.")
}

export async function readPlan(root: string, rawName: string): Promise<string> {
  await ensurePlanDirectory(root)
  const path = planPath(root, rawName)
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Plan must be a regular Markdown file: ${normalizePlanName(rawName)}`)
  }
  return readFile(path, "utf8")
}

export async function writePlan(
  root: string,
  rawName: string,
  content: string,
  expectedContent?: string,
): Promise<void> {
  await ensurePlanDirectory(root)
  const name = normalizePlanName(rawName)
  const path = planPath(root, name)
  const current = await readExistingPlan(path, name)

  if (current === undefined && expectedContent !== undefined) {
    throw new PlanConflictError(`Plan no longer exists: ${name}`)
  }
  if (current !== undefined && expectedContent === undefined) {
    throw new PlanConflictError(`Plan already exists: ${name}`)
  }
  if (current !== undefined && current !== expectedContent) {
    throw new PlanConflictError(`Plan changed since it was read: ${name}`)
  }

  await atomicWrite(path, content)
}

export async function editPlan(
  root: string,
  rawName: string,
  oldText: string,
  newText: string,
): Promise<void> {
  if (oldText.length === 0) throw new Error("oldText must not be empty.")
  const current = await readPlan(root, rawName)
  const first = current.indexOf(oldText)
  if (first < 0) throw new PlanConflictError("oldText was not found in the current plan.")
  if (current.indexOf(oldText, first + oldText.length) >= 0) {
    throw new PlanConflictError("oldText must match exactly one location in the current plan.")
  }
  await writePlan(root, rawName, current.replace(oldText, newText), current)
}

async function readExistingPlan(path: string, name: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Plan must be a regular Markdown file: ${name}`)
    }
    return readFile(path, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
