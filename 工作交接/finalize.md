# /finalize — 完工检查 + 提交推送

通用完工检查流程。所有检测项都从项目自身结构动态发现。

## 步骤

### 1. 代码质量检查

**自动发现项目语言和文件类型：**

```bash
HAS_PY=0; HAS_JS=0; HAS_GO=0; HAS_RS=0; HAS_CS=0
ls requirements.txt pyproject.toml setup.py Pipfile 2>/dev/null && HAS_PY=1
ls package.json 2>/dev/null && HAS_JS=1
ls go.mod go.sum 2>/dev/null && HAS_GO=1
ls Cargo.toml 2>/dev/null && HAS_RS=1
ls *.csproj 2>/dev/null && HAS_CS=1
```

**根据语言检查 TODO/FIXME/HACK/XXX：**

```bash
EXTS=""
[ "$HAS_PY" = "1" ] && EXTS="$EXTS --include=*.py"
[ "$HAS_JS" = "1" ] && EXTS="$EXTS --include=*.ts --include=*.vue --include=*.js --include=*.tsx --include=*.jsx --include=*.svelte"
[ "$HAS_GO" = "1" ] && EXTS="$EXTS --include=*.go"
[ "$HAS_RS" = "1" ] && EXTS="$EXTS --include=*.rs"
[ "$HAS_CS" = "1" ] && EXTS="$EXTS --include=*.cs"
[ -n "$EXTS" ] && grep -rn "TODO\|FIXME\|HACK\|XXX" . $EXTS | grep -v "__pycache__" | grep -v "node_modules" | grep -v ".git"
```

**调试语句泄漏：**

```bash
[ "$HAS_PY" = "1" ] && grep -rn "^ *print(" . --include="*.py" | grep -v "__pycache__" | grep -v "test_" | grep -v "conftest"
[ "$HAS_JS" = "1" ] && grep -rn "console\.log\|debugger" . --include="*.ts" --include="*.js" --include="*.vue" | grep -v "node_modules" | grep -v ".spec." | grep -v ".test."
[ "$HAS_GO" = "1" ] && grep -rn "fmt\.Print\|log\.Print\|log\.Fatal" . --include="*.go" | grep -v "_test.go"
```

**注释代码残留：**

```bash
[ "$HAS_PY" = "1" ] && grep -rn "^ *# import\|^ *# from" . --include="*.py" | grep -v "__pycache__" | grep -v "conftest"
[ "$HAS_GO" = "1" ] && grep -rn "^ *// import\|^ *// var\|^ *// func" . --include="*.go" | grep -v "_test.go"
```

### 2. 需求追溯自动检测（如有需求文档）

**如果项目有需求文档，自动交叉验证：提取 ❌ Missing 条目关键词，去代码里搜是否存在。**

```bash
# 自动发现需求文档
REQUIREMENTS=$(find . -maxdepth 3 -type f \( \
  -name "需求文档*" -o -name "requirements*" -o -name "PRD*" -o -name "specs*" \
\) 2>/dev/null | grep -v node_modules | grep -v .git | head -3)
```

**如果有需求文档，执行自动检测：**

```bash
# 列出所有 ❌ Missing / TODO 条目（自动发现，不写死）
grep -n "❌\|Missing\|TODO\|未实现" "$REQUIREMENTS" 2>/dev/null || echo "无未实现条目"
```

- 有未实现条目 → 从每条需求描述中提取 2-3 个核心关键词
- 在代码目录中 grep 关键词，有命中且出现 3 次以上 → 很可能已实现
- 检测为已实现但文档标记未实现 → 更新为 Done
- 检测确实未实现 → 确认 Missing
- 无需求文档 → 跳过，提示"未发现需求文档"

### 3. 补全测试脚本

**分析最近代码变更，检查是否有对应的测试覆盖。**

```bash
# 查看最近一次提交以来的代码变更文件
CHANGED_FILES=$(git diff HEAD~1 --name-only 2>/dev/null | grep -v "__pycache__" | grep -v ".md$" | grep -v ".git/" || echo "")
```

- 有代码变更 → 检查这些文件是否有对应的测试。如果没有或覆盖不足，补充测试用例
- 无代码变更 → 跳过

**补全测试的原则：**
- 新增的 API 端点 → 补对应的请求测试
- 新增的服务函数 → 补对应的逻辑测试
- 新增的配置项 → 补默认值测试
- 新增的模型 → 补 CRUD 测试
- 已有测试但变更的函数 → 更新断言

### 4. 运行全部测试（项目自发现）

**自动发现测试目录和配置：**

```bash
# 扫描测试目录
TEST_DIRS=$(find . -maxdepth 2 -type d \( -name tests -o -name test -o -name __tests__ -o -name specs -o -name spec \) 2>/dev/null | grep -v node_modules | grep -v .git)

# 扫描测试配置文件
HAS_PYTEST=0; HAS_JEST=0; HAS_VITEST=0; HAS_CARGO_TEST=0; HAS_GO_TEST=0; HAS_MAKETEST=0; HAS_JUSTTEST=0; HAS_RUNTESTS=0
[ -f pytest.ini ] || grep -q "\[tool.pytest" pyproject.toml 2>/dev/null && HAS_PYTEST=1
[ -f jest.config.js ] || [ -f jest.config.ts ] || grep -q '"jest"' package.json 2>/dev/null && HAS_JEST=1
[ -f vitest.config.js ] || [ -f vitest.config.ts ] || grep -q '"vitest"' package.json 2>/dev/null && HAS_VITEST=1
[ -f Cargo.toml ] && HAS_CARGO_TEST=1
[ -f go.mod ] && HAS_GO_TEST=1
grep -q "^test:" Makefile 2>/dev/null && HAS_MAKETEST=1
grep -q "^test:" justfile 2>/dev/null && HAS_JUSTTEST=1
ls run_tests.sh test.sh scripts/test.sh scripts/run_tests.sh 2>/dev/null && HAS_RUNTESTS=1

TEST_RAN=0

# 优先级：task runner → 框架配置 → 语言默认
if [ "$HAS_MAKETEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then make test && TEST_RAN=1; fi
if [ "$HAS_JUSTTEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then just test && TEST_RAN=1; fi
if [ "$HAS_JEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then npx jest --passWithNoTests 2>&1 | tail -5 && TEST_RAN=1; fi
if [ "$HAS_VITEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then npx vitest run 2>&1 | tail -5 && TEST_RAN=1; fi
if [ "$HAS_PYTEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then .venv/bin/python -m pytest tests/ -x -q --tb=short 2>&1 | tail -5 && TEST_RAN=1; fi
if [ "$HAS_CARGO_TEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then cargo test 2>&1 | tail -5 && TEST_RAN=1; fi
if [ "$HAS_GO_TEST" = "1" ] && [ "$TEST_RAN" = "0" ]; then go test ./... 2>&1 | tail -5 && TEST_RAN=1; fi

# 兜底：如果有测试目录但没有配置，尝试 pytest（最常见的无配置场景）
if [ "$TEST_RAN" = "0" ] && [ -n "$TEST_DIRS" ] && [ "$HAS_PY" = "1" ]; then
  .venv/bin/python -m pytest $TEST_DIRS -x -q --tb=short 2>&1 | tail -5 && TEST_RAN=1
fi

# 最后：跑自定义脚本
if [ "$HAS_RUNTESTS" = "1" ] && [ "$TEST_RAN" = "0" ]; then
  for f in run_tests.sh test.sh scripts/test.sh scripts/run_tests.sh; do
    [ -f "$f" ] && bash "$f" 2>&1 | tail -5 && TEST_RAN=1 && break
  done
fi
```

- 通过 → 继续，输出测试框架名称
- 失败 → **停止**，修复失败项，重新测试，直到通过
- 无测试 → 跳过，提示"未发现测试配置"

### 5. 文档更新检查（项目自发现 + 实质验证）

**自动发现文档目录和文件：**

```bash
# 扫描文档目录
DOC_DIRS=$(find . -maxdepth 2 -type d \( -name doc -o -name docs -o -name documentation \) 2>/dev/null | grep -v node_modules | grep -v .git)

# 扫描文档文件（用 find 替代 glob，支持中文文件名）
DOC_FILES=$(find . -maxdepth 3 -type f \( \
  -name "README.md" -o -name "CHANGELOG.md" -o -name "PROGRESS.md" -o \
  -name "开发记录*" -o -name "项目状态*" -o -name "开发日志*" -o \
  -name "changelog*" -o -name "CONTRIBUTING*" -o -name "TODO*" \
\) 2>/dev/null | grep -v node_modules | grep -v .git)

# 同时扫描 doc/docs 目录下最近的 .md 文件
if [ -n "$DOC_DIRS" ]; then
  DOC_IN_DIRS=$(find $DOC_DIRS -maxdepth 2 -type f -name "*.md" 2>/dev/null | grep -v node_modules | grep -v .git | head -20)
  DOC_FILES="$DOC_FILES $DOC_IN_DIRS"
fi

# 去重
DOC_FILES=$(echo "$DOC_FILES" | sort -u | grep -v "^$")

# 检查最近修改的文档（过去 1 天内）
if [ -n "$DOC_FILES" ]; then
  for f in $DOC_FILES; do
    git log -1 --format="%ci %s" -- "$f" 2>/dev/null
  done
fi
```

**文档内容实质验证（关键步骤 — 不要只看文件有没有被修改）：**

```bash
# 获取今天（或最近一次提交以来）的 commit subjects
TODAY_COMMITS=$(git log --oneline --since="1 day ago" --format="%s" 2>/dev/null)

# 获取最近一次提交以来变更的非文档代码文件
CODE_CHANGED=$(git diff --name-only HEAD~1 2>/dev/null | grep -v "^doc/\|^docs/\|^\.md$" | head -10)
```

- 有今天的代码变更 → 对每个 commit subject，**在开发记录/变更日志中 grep 关键词**，确认是否被记录
  - 例：commit "feat: 后台查询补全执行流程" → 在 `doc/开发记录-*.md` 中搜索"后台查询"、"pipeline"、"执行流程"
  - 例：commit "fix: 自动数据库迁移" → 搜索"数据库迁移"、"ALTER TABLE"、"auto-migration"
- **关键词有命中且上下文是记录变更**（不是旧内容重复） → 文档已实质更新
- **关键词未命中或只出现在旧段落** → ⚠️ 文档未实质更新，标记为 MISSING 并提示需要补全
- 无文档 → 跳过

### 6. 检查未提交变更

```bash
git status --short
git diff --stat
```

- 无变更 → 提示"没有需要提交的内容"，结束
- 有变更 → 展示变更摘要，进入下一步

### 7. 提交 + 推送

```bash
git add -A
git status --short
```

展示暂存列表，根据 `git diff` 自动生成 conventional commit 提交信息，或采用用户提供的描述：

```bash
git commit -m "<提交信息>"
git push
```

## 输出格式

```
[1/7] 代码质量检查 — ✅ 无问题
[2/7] 需求追溯 — ✅ 无未实现条目 / 3 个条目更新为 Done
[3/7] 测试补全 — +5 个新测试用例
[4/7] 全部测试 — ✅ 197 passed (pytest)
[5/7] 文档检查 — ✅ 3 个文档目录，开发记录覆盖今日 6 个 commit
[6/7] 变更检查 — 3 files changed
[7/7] 提交推送 — ✅ abc1234 pushed
```

## 规则

- 任何一步失败，**不要提交**，报告问题并等待用户指令
- 不修改业务逻辑代码，只做检查
- 提交信息遵循 conventional commits（feat/fix/docs/chore/refactor）
- 如果仓库没有远程分支，跳过 push 并提示
- 测试/文档/需求文件未检测到 → 跳过不阻塞，但明确提示
- 测试失败 → **停止**，修复后再跑，不要提交
- 第 5 步文档检查：**必须对 commit subject 做关键词 grep 验证**，不能只看文档文件是否被 touched
