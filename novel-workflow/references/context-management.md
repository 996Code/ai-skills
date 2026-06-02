# 上下文管理与中断防护

> SKILL.md的详细上下文管理规则，遇到中断问题时按需加载。

## 根因分析（2026-05-31 讯飞API中断事件）

**问题链**：
1. **NotEnoughCvError**：API在上下文超过窗口时报错。
2. **Unrepairable tool_call**：模型生成write_file/execute_code时参数被截断，Hermes将残缺参数替换为空对象`{}`，导致写入空文件或执行失败。
3. **delegate_task超时**：子代理max_iterations=50，在复杂任务中耗尽迭代，返回空结果。
4. **上下文压缩延迟**：压缩用同一个API，压缩期间无法处理新消息，造成"卡住"假象。

**⚠️ 根因的根因：Hermes中文token估算偏差**

Hermes的token估算公式是 `(字符数+3)÷4`（即1 token ≈ 4 chars），这是按英文设计的。对中文：
- 1个汉字 = 1 char → Hermes算0.25 token
- 讯飞实际：1个汉字 ≈ 1-2 tokens
- **偏差4-8倍**

后果：Hermes以为上下文才122K tokens，讯飞实际已经200K+ tokens → 直接爆窗。

**Hermes最低context_length要求：64000**（低于此值压缩功能会报ValueError拒绝工作）。

## 防护措施

**配置层**（需在 `config.yaml` 中设置）：
```yaml
model:
  context_length: 80000  # 平衡方案：Hermes估算80K时讯飞实际约160K，留20%余量
compression:
  threshold: 0.3  # 24K触发压缩，讯飞实际约48-96K，安全
  target_ratio: 0.15  # 压缩后12K，讯飞实际约24-48K，安全
delegation:
  max_iterations: 80  # 子代理更多迭代，避免耗尽
```

**为什么选80K而非64K**：64K虽然最保守，但上下文空间偏小，对话容易频繁压缩（每次压缩需1-2分钟，期间无法处理消息）。80K是平衡方案——Hermes估算80K时，讯飞实际约160K（中英混合场景），仍低于200K窗口，留有20%余量。

**操作层**：
- **分段执行**：长任务主动分段，每完成一章检查上下文状态
- **避免大文件读取**：不要一次性读取超过10K字符的文件，用offset+limit分页
- **子代理任务拆小**：每个delegate_task只做一件事
- **审查写文件**：子代理审查结果必须写文件，不靠返回值

**中断恢复**：
- 如果收到 `[System note: Your previous turn was interrupted]`，立即检查：
  1. 上一个write_file是否成功（read_file验证内容非空）
  2. 上一个delegate_task是否返回有效结果（非空summary）
  3. 如果失败，重新执行该步骤，不要跳过

**警告信号**：
- 日志中出现 `NotEnoughCvError` → 上下文即将溢出，主动压缩或分段
- 日志中出现 `Unrepairable tool_call` → 参数被截断，检查上一个工具调用结果
- `delegate_task` 返回空summary → 子代理超时，拆小任务重试
- 日志中出现 `context window of X tokens, which is below the minimum 64,000` → context_length设太低了，必须≥64000

> ⚡ 详细根因分析和日志记录见 `references/context-interruption-analysis.md`
