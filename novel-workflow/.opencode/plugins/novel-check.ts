/**
 * novel-check.ts — opencode 插件（无外部依赖，避免本地 node_modules）
 *
 * 作用：替代 Claude Code `.claude/settings.json` 的 PostToolUse hook。
 *
 * 两层保护：
 *  1) tool.execute.before（硬门禁）：写/改第 N 章前先验「上一章」第 N-1 章 --single；
 *     上一章没过就 throw 阻断本次写入——错误信息会回传给模型（opencode #6862），
 *     模型必须先把上一章修绿才能开写下一章。等价于"禁止未过单章检查就连写多章"。
 *  2) tool.execute.after（软提醒）：写完立刻跑 --single，结果落日志+控制台红字，不 throw（避免 TUI 风险）。
 *
 * 加载：放 .opencode/plugins/，opencode 启动自动加载。仅用 Bun 内置 $，无 npm 依赖。
 * 不 import @opencode-ai/plugin —— 那个类型导入会触发 opencode 本地 bun install，
 * 换全局安装时不需要。类型用内联宽松定义。
 */

type AnyCtx = { client: any; $: any; directory: string }

const CHAPTER_RE = /(novels\/[^/]+\/text\/)第(\d+)章[^/]*\.txt$/
const HIT_RE = /❌|不合格|缺失|重复|建议|破折号|锚点|字数|钩子|SDT|觉得|意识到/

const NovelCheckPlugin = async ({ client, $, directory }: AnyCtx) => {
  const checkSingle = async (path: string) => {
    const script = directory + "/scripts/novel_check.py"
    const r = await $`python3 ${script} --single ${path}`.nothrow()
    const out = String(r.stdout || "") + String(r.stderr || "")
    return { ok: r.exitCode === 0, out }
  }

  const appendLog = async (line: string) => {
    try {
      await $`mkdir -p ${directory + "/.opencode/logs"}`
      const stamp = (await $`date '+%Y-%m-%d %H:%M:%S'`.text()).trim()
      await $`printf %s\\n ${`[${stamp}] ${line}\n`} >> ${directory + "/.opencode/logs/novel-check.log"}`
    } catch {}
  }

  const pick = (out: string, n = 12) =>
    out.split("\n").filter((l) => HIT_RE.test(l)).slice(0, n).join("\n")

  return {
    // ── 硬门禁 ──────────────────────────────────────────────
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (input.tool !== "write" && input.tool !== "edit") return
        const args = (output?.args ?? input?.args ?? {}) as Record<string, unknown>
        const p = String((args.filePath as string) ?? (args.path as string) ?? "")
        const m = p.replace(/\\/g, "/").match(CHAPTER_RE)
        if (!m) return

        const textDir = m[1]
        const n = parseInt(m[2], 10)
        const prev = n - 1
        if (prev < 1) return // 第一章，无上一章，放行

        const list = await $`ls ${directory + "/" + textDir}第${prev}章*.txt`.text().catch(() => "")
        const prevFile = list.split("\n").map((s) => s.trim()).filter(Boolean)[0]
        if (!prevFile) return // 上一章还没建（接续写作的第一章），放行

        const res = await checkSingle(prevFile)
        if (!res.ok) {
          const lines = pick(res.out, 10)
          await appendLog(`🛑 BLOCKED 写第${n}章：上一章第${prev}章未过 --single\n${res.out.slice(0, 1500)}`)
          throw new Error(
            `【门禁阻断】禁止写/改第${n}章——上一章「第${prev}章」单章检查未通过。\n${lines}\n\n` +
              `请先修复第${prev}章，运行：python3 scripts/novel_check.py --single "${prevFile}"\n` +
              `通过后（exit 0）再写第${n}章。门禁规则：第 N-1 章没过，第 N 章写不进去。`,
          )
        }
      } catch (e: any) {
        // 只把「门禁阻断」向上抛；其它意外吞掉，绝不破坏 TUI
        if (e instanceof Error && /门禁阻断/.test(e.message)) throw e
      }
    },

    // ── 软提醒（不 throw）────────────────────────────────────
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (input.tool !== "write" && input.tool !== "edit") return
        const args = (output?.args ?? input?.args ?? {}) as Record<string, unknown>
        const p = String((args.filePath as string) ?? (args.path as string) ?? "")
        const norm = p.replace(/\\/g, "/")
        if (!/novels\/.*\/text\/第.*章.*\.txt$/.test(norm)) return

        const res = await checkSingle(p)
        await client.app.log({
          body: {
            service: "novel-check",
            level: res.ok ? "info" : "warn",
            message: `${res.ok ? "✅" : "❌"} --single ${p}`,
            extra: { out: res.out.slice(0, 2000) },
          },
        })
        await appendLog(`${res.ok ? "✅" : "❌"} ${p}\n${res.out.slice(0, 3000)}`)
        if (!res.ok) {
          console.error(
            `【本章未通过 --single】${p}\n${pick(res.out)}\n→ python3 scripts/novel_check.py --single "${p}"`,
          )
        }
      } catch {}
    },
  }
}

export default NovelCheckPlugin
