import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "vitest"
import {
  editPlan,
  listPlans,
  normalizePlanName,
  PlanConflictError,
  readPlan,
  suggestedPlanName,
  uniquePlanName,
  writePlan,
} from "../src/storage.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-plans-"))
  roots.push(root)
  return join(root, "plans")
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

test("normalizes safe names and rejects directory traversal", () => {
  assert.equal(normalizePlanName("研究計畫"), "研究計畫.md")
  assert.equal(normalizePlanName("@release.md"), "release.md")
  assert.throws(() => normalizePlanName("../escape.md"))
  assert.throws(() => normalizePlanName("nested/escape.md"))
  assert.throws(() => normalizePlanName("bad\\name.md"))
})

test("suggests dated Unicode names and allocates a unique suffix", async () => {
  const root = await temporaryRoot()
  const now = new Date("2026-03-01T00:00:00.000Z")
  const first = suggestedPlanName("登入流程研究", now)
  assert.equal(first, "2026-03-01_登入流程研究-plan.md")
  await writePlan(root, first, "# First\n")
  assert.equal(await uniquePlanName(root, "登入流程研究", now), "2026-03-01_登入流程研究-plan-2.md")
})

test("creates, lists, reads, and safely replaces plans", async () => {
  const root = await temporaryRoot()
  await writePlan(root, "alpha", "# Alpha\n")

  assert.equal(await readPlan(root, "alpha.md"), "# Alpha\n")
  assert.deepEqual(
    (await listPlans(root)).map((plan) => plan.name),
    ["alpha.md"],
  )
  await assert.rejects(() => writePlan(root, "alpha", "lost update"), PlanConflictError)
  await assert.rejects(() => writePlan(root, "alpha", "new", "stale"), PlanConflictError)

  await writePlan(root, "alpha", "# Updated\n", "# Alpha\n")
  assert.equal(await readPlan(root, "alpha"), "# Updated\n")
})

test("exact edits require one match and plan listing ignores symlinks", async () => {
  const root = await temporaryRoot()
  await writePlan(root, "alpha", "one two one\n")
  await assert.rejects(() => editPlan(root, "alpha", "one", "three"), PlanConflictError)
  await editPlan(root, "alpha", "two", "three")
  assert.equal(await readPlan(root, "alpha"), "one three one\n")

  const outside = join(root, "..", "outside.md")
  await writeFile(outside, "outside\n", "utf8")
  await symlink(outside, join(root, "linked.md"))
  assert.deepEqual(
    (await listPlans(root)).map((plan) => plan.name),
    ["alpha.md"],
  )
  await assert.rejects(() => readPlan(root, "linked.md"))
})
