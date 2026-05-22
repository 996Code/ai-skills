# 任务：add-hello-endpoint

## 实现任务

- [ ] **T1**：初始化项目依赖
  - 运行 `npm init -y` 创建 package.json
  - 安装 express：`npm install express`
  - 安装测试依赖：`npm install --save-dev jest supertest`
  - 在 package.json 中添加 test script：`"test": "jest"`
  - _依赖：无_

- [ ] **T2**：创建 Express 应用和 /hello 路由
  - 创建 `app.js`，导出 Express app 实例
  - 注册 `GET /hello` 路由，返回 `{ "message": "你好，世界！" }`
  - 创建 `server.js`，引入 app 并监听端口
  - _依赖：T1_

- [ ] **T3**：编写 /hello 端点测试
  - 创建 `app.test.js`
  - 测试用例 1：GET /hello 返回 200
  - 测试用例 2：响应体包含 `{ "message": "你好，世界！" }`
  - 测试用例 3：Content-Type 为 application/json
  - _依赖：T2_

- [ ] **T4**：端到端验证
  - 运行 `npm test`，确认所有测试通过
  - 启动服务器，用 curl 验证 GET /hello 返回预期响应
  - _依赖：T3_
