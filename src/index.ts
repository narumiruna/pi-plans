import { join } from "node:path"
import { StringEnum } from "@earendil-works/pi-ai"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionCommandContext,
  formatSize,
  getAgentDir,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { editPlan, listPlans, planPath, readPlan, uniquePlanName, writePlan } from "./storage.js"

const PLAN_ROOT = join(getAgentDir(), "plans")
const PLAN_ACTIONS = ["list", "read", "create", "replace", "edit"] as const
const PLAN_KINDS = ["實作計畫", "測試計畫", "研究計畫", "一般計畫"] as const

type PlanKindLabel = (typeof PLAN_KINDS)[number]

interface FlowGuard {
  signal: AbortSignal
  isCurrent: () => boolean
}

export default function plansExtension(pi: ExtensionAPI): void {
  let generation = 0
  let active = false
  let sessionController = new AbortController()

  pi.on("session_start", () => {
    sessionController.abort()
    sessionController = new AbortController()
    generation += 1
    active = true
  })

  pi.on("session_shutdown", () => {
    sessionController.abort()
    generation += 1
    active = false
  })

  pi.registerTool({
    name: "plan_document",
    label: "Plan Document",
    description:
      "List, read, create, replace, or exactly edit Markdown plan documents stored under the user's Pi agent plan directory. Replacing an existing plan requires the exact content returned by a prior read as expectedContent. Tool output is limited to 50 KB or 2,000 lines.",
    promptSnippet: "Manage durable Markdown plan documents in the user's Pi agent plan directory",
    promptGuidelines: [
      "Use plan_document when the user asks to create, inspect, or revise a durable plan document managed by the /plans command.",
      "Before replacing an existing plan with plan_document, read it and pass its exact current content as expectedContent; use the edit action for a unique exact-text change.",
    ],
    parameters: Type.Object({
      action: StringEnum(PLAN_ACTIONS),
      name: Type.Optional(Type.String({ description: "Plan filename; .md is added when omitted" })),
      content: Type.Optional(
        Type.String({ description: "Complete Markdown for create or replace" }),
      ),
      expectedContent: Type.Optional(
        Type.String({ description: "Exact content from the prior read, required by replace" }),
      ),
      oldText: Type.Optional(Type.String({ description: "Unique exact text required by edit" })),
      newText: Type.Optional(Type.String({ description: "Replacement text required by edit" })),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted()

      switch (params.action) {
        case "list": {
          const plans = await listPlans(PLAN_ROOT)
          const text =
            plans.length === 0
              ? `No plan documents found in ${PLAN_ROOT}.`
              : plans
                  .map(
                    (plan) =>
                      `${plan.name}\t${formatSize(plan.size)}\t${plan.modifiedAt.toISOString()}`,
                  )
                  .join("\n")
          return boundedResult(text, { action: params.action, count: plans.length })
        }
        case "read": {
          const name = requireString(params.name, "name")
          const content = await readPlan(PLAN_ROOT, name)
          return boundedResult(content, { action: params.action, name })
        }
        case "create": {
          const name = requireString(params.name, "name")
          const content = requireString(params.content, "content", true)
          await mutatePlan(name, signal, () => writePlan(PLAN_ROOT, name, content))
          return shortResult(`Created plan: ${planPath(PLAN_ROOT, name)}`, params.action, name)
        }
        case "replace": {
          const name = requireString(params.name, "name")
          const content = requireString(params.content, "content", true)
          const expectedContent = requireString(params.expectedContent, "expectedContent", true)
          await mutatePlan(name, signal, () => writePlan(PLAN_ROOT, name, content, expectedContent))
          return shortResult(`Replaced plan: ${planPath(PLAN_ROOT, name)}`, params.action, name)
        }
        case "edit": {
          const name = requireString(params.name, "name")
          const oldText = requireString(params.oldText, "oldText")
          const newText = requireString(params.newText, "newText", true)
          await mutatePlan(name, signal, () => editPlan(PLAN_ROOT, name, oldText, newText))
          return shortResult(`Edited plan: ${planPath(PLAN_ROOT, name)}`, params.action, name)
        }
      }
    },
  })

  pi.registerCommand("plans", {
    description: "Create, open, and revise saved plan documents",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /plans")
      if (!ctx.hasUI || ctx.mode !== "tui") {
        throw new Error(`/plans requires Pi's interactive TUI; current mode: ${ctx.mode}`)
      }
      if (!active) throw new Error("/plans is unavailable before the session starts.")

      const ownerGeneration = generation
      const flow: FlowGuard = {
        signal: sessionController.signal,
        isCurrent: () =>
          active && generation === ownerGeneration && !sessionController.signal.aborted,
      }
      const count = (await listPlans(PLAN_ROOT)).length
      if (!flow.isCurrent()) return
      const action = await ctx.ui.select(
        `計畫文件（${count}）`,
        ["請 Pi 起草新計畫", "開啟或修改計畫", "請 Pi 改進既有計畫", "顯示儲存位置"],
        { signal: flow.signal },
      )
      if (!flow.isCurrent() || !action) return

      switch (action) {
        case "請 Pi 起草新計畫":
          await draftPlanWithPi(pi, ctx, flow)
          return
        case "開啟或修改計畫":
          await openPlanEditor(ctx, flow)
          return
        case "請 Pi 改進既有計畫":
          await revisePlanWithPi(pi, ctx, flow)
          return
        case "顯示儲存位置":
          ctx.ui.notify(PLAN_ROOT, "info")
      }
    },
  })
}

async function draftPlanWithPi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  flow: FlowGuard,
): Promise<void> {
  const title = (
    await ctx.ui.input("計畫名稱", "例如：驗證登入流程", { signal: flow.signal })
  )?.trim()
  if (!flow.isCurrent() || !title) return

  const kindLabel = (await ctx.ui.select("計畫類型", [...PLAN_KINDS], {
    signal: flow.signal,
  })) as PlanKindLabel | undefined
  if (!flow.isCurrent() || !kindLabel) return

  const brief = (await ctx.ui.editor("目標、範圍、限制與已知資訊", ""))?.trim()
  if (!flow.isCurrent() || !brief) return

  const name = await uniquePlanName(PLAN_ROOT, title)
  if (!flow.isCurrent()) return
  const prompt = `請為我起草一份${kindLabel}，但不要執行計畫。

標題：${title}
預定檔名：${name}
需求：
${brief}

請先依需要調查目前工作目錄中的相關證據，再使用 plan_document 的 create 動作，把完整計畫存成 ${name}。計畫應精簡、可執行且可驗證，至少包含 Goal、Plan、Completion Checklist；只在有幫助時加入 Context、Architecture、Assumptions、Unknowns、Risks 或 Rollback / Recovery。每個步驟需說明動作、預期結果與驗證方式。測試計畫應涵蓋範圍、案例與進退場條件；研究計畫應涵蓋問題、方法、證據來源與決策標準。使用與這份需求相同的語言。儲存成功後，回覆檔名與摘要。`

  await ctx.waitForIdle()
  if (!flow.isCurrent()) return
  pi.sendUserMessage(prompt)
}

async function openPlanEditor(ctx: ExtensionCommandContext, flow: FlowGuard): Promise<void> {
  const name = await pickPlan(ctx, "選擇要開啟的計畫", flow)
  if (!flow.isCurrent() || !name) return

  const original = await readPlan(PLAN_ROOT, name)
  if (!flow.isCurrent()) return
  const edited = await ctx.ui.editor(`修改 ${name}`, original)
  if (!flow.isCurrent() || edited === undefined || edited === original) return

  await withFileMutationQueue(planPath(PLAN_ROOT, name), async () => {
    flow.signal.throwIfAborted()
    await writePlan(PLAN_ROOT, name, edited, original)
  })
  if (flow.isCurrent()) ctx.ui.notify(`已儲存 ${name}`, "info")
}

async function revisePlanWithPi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  flow: FlowGuard,
): Promise<void> {
  const name = await pickPlan(ctx, "選擇要改進的計畫", flow)
  if (!flow.isCurrent() || !name) return

  const instructions = (await ctx.ui.editor("希望如何改進這份計畫？", ""))?.trim()
  if (!flow.isCurrent() || !instructions) return

  const prompt = `請改進既有計畫 ${name}，但不要執行計畫。

修改要求：
${instructions}

請先用 plan_document 的 read 動作讀取目前內容；接著使用 edit 做唯一的精確修改，或使用 replace 並傳回剛讀到的完整內容作為 expectedContent。保留仍然正確的資訊，讓步驟維持精簡、依賴順序、可執行且有明確驗證證據。儲存成功後，摘要說明修改內容。`

  await ctx.waitForIdle()
  if (!flow.isCurrent()) return
  pi.sendUserMessage(prompt)
}

async function pickPlan(
  ctx: ExtensionCommandContext,
  title: string,
  flow: FlowGuard,
): Promise<string | undefined> {
  const plans = await listPlans(PLAN_ROOT)
  if (!flow.isCurrent()) return undefined
  if (plans.length === 0) {
    ctx.ui.notify(`尚無計畫文件；可從 /plans 請 Pi 起草。\n${PLAN_ROOT}`, "warning")
    return undefined
  }
  const selected = await ctx.ui.select(
    title,
    plans.map((plan) => plan.name),
    { signal: flow.signal },
  )
  return flow.isCurrent() ? selected : undefined
}

async function mutatePlan(
  name: string,
  signal: AbortSignal | undefined,
  mutation: () => Promise<void>,
): Promise<void> {
  await withFileMutationQueue(planPath(PLAN_ROOT, name), async () => {
    signal?.throwIfAborted()
    await mutation()
  })
}

function requireString(value: string | undefined, field: string, allowEmpty = false): string {
  if (value === undefined || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} is required for this plan_document action.`)
  }
  return value
}

function boundedResult(text: string, details: Record<string, unknown>) {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  })
  const suffix = truncation.truncated
    ? `\n\n[Output truncated to ${truncation.outputLines} lines and ${formatSize(truncation.outputBytes)}. Use plan_document edit with unique visible text for a focused change.]`
    : ""
  return {
    content: [{ type: "text" as const, text: truncation.content + suffix }],
    details: { ...details, truncated: truncation.truncated },
  }
}

function shortResult(message: string, action: string, name: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { action, name, truncated: false },
  }
}
